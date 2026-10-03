import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { requestFingerprint } from "./release-security.js";
import { prepareChatStep, buildChatExecutionBody } from "./release-refinements.js";
import { prepareAuditStep } from "./release-audit-steps.js";
import { releaseFailedExecutivePremium } from "./release-executive-refiner.js";

export const operationContext = new AsyncLocalStorage();
const auditTasks = new Set(["seo_analysis","pdf_summary","pdf_polish","premium_reasoning_audit","executive_refiner_pdf"]);

export function hasUsableResponse(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return false;
    if (/^[{[]/.test(text)) {
      try { return hasUsableResponse(JSON.parse(text)); } catch (_) { /* Keep recoverable partial text. */ }
    }
    return true;
  }
  if (Array.isArray(value)) return value.some(hasUsableResponse);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasUsableResponse);
}

export function createOperationGuard({ client, isUnlimited = () => false }) {
  return async function reserveGeneration(req, res, next) {
    const routePath = req.path.replace(/\/+$/, "").toLowerCase();
    if (!["/api/chat", "/api/chat/stream"].includes(routePath) || req.method !== "POST") return next();
    try {
      const task = String(req.body?.zentra_routing?.taskType || req.body?.task_type || "chat_basic").trim().toLowerCase();
      if (!Array.isArray(req.body?.messages) || !req.body.messages.some(message =>
        typeof message?.content === "string" ? Boolean(message.content.trim()) : Array.isArray(message?.content) && message.content.length > 0
      )) return res.status(400).json({ error: "La solicitud no contiene mensajes." });
      const kind = auditTasks.has(task) ? "audit" : "chat";
      const envelope = req.body?.zentra_operation || {};
      const acquisitionToken = req.body?.zentra_acquisition?.token;
      const product = envelope.product === "audit" ? "audit" : "subscription";
      const operationId = envelope.id || crypto.randomUUID();
      const prepare = kind === "chat" ? prepareChatStep : prepareAuditStep;
      const prepared = await prepare({ client, identity: req.auth, product, operationId, body: req.body });
      if (prepared.conflict) return res.status(409).json({ error: "No se pudo continuar esta solicitud.", code: "operation_conflict" });
      req.body = prepared.body;
      delete req.body.zentra_acquisition;
      const sourceHash = prepared.sourceHash;
      const fingerprint = requestFingerprint(req.body);
      if (task === 'executive_refiner_pdf') {
        const resumed = await client.rpc('zentra_resume_executive', {
          p_auth_id: req.auth.userId, p_email: req.auth.email, p_product: product,
          p_operation: operationId, p_hash: fingerprint
        });
        if (resumed.error) throw resumed.error;
      }
      const result = await client.rpc("zentra_begin_request", {
        p_auth_id: req.auth.userId, p_email: req.auth.email, p_product: product,
        p_operation: operationId, p_source: sourceHash, p_hash: fingerprint, p_kind: kind,
        p_unlimited: isUnlimited(req.auth.email),
        ...(acquisitionToken ? { p_acquisition: acquisitionToken } : {})
      });
      if (result.error) throw result.error;
      const reservation = result.data;
      if (!reservation?.allowed) {
        const status = reservation?.reason === "in_progress" ? 425 :
          reservation?.reason === "usage_limit_reached" ? 403 : 409;
        return res.set("Retry-After", "2").status(status).json({
          error: status === 403 ? "Alcanzaste el limite de tu plan." :
            status === 425 ? "La respuesta sigue en curso." : "No se pudo continuar esta solicitud.",
          code: reservation?.reason || "operation_conflict"
        });
      }
      const operation = {
        id: operationId, product, kind, user: reservation.user,
        requestHash: fingerprint, leaseToken: reservation.lease_token,
        paidCounters: new Set(reservation.paid_counters || [])
      };
      req.operation = operation;
      if (reservation.cached) {
        if (routePath.endsWith("/stream")) {
          res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          return res.end(JSON.stringify({ type: "final", text: reservation.response?.text || "" }) + "\n");
        }
        return res.json(reservation.response?.body || { success: true, response: reservation.response?.text || "" });
      }
      // Keep the stored fingerprint/lease for idempotency; only the provider copy
      // receives the current plan's instructions. Cached/running actions never rebuild.
      req.body = await buildChatExecutionBody(prepared, reservation.user);
      let completed = false;
      const lease = {
        p_user: reservation.user.id, p_operation: operationId,
        p_hash: fingerprint, p_lease: reservation.lease_token
      };
      req.startProviderOperation = operation.startProvider = async () => {
        const { data, error } = await client.rpc("zentra_start_provider", lease);
        if (error || data !== true) throw new Error("Execution ownership unavailable");
      };
      req.checkpointOperation = async text => {
        if (!hasUsableResponse(text)) return;
        const { data, error } = await client.rpc("zentra_checkpoint_response", {
          ...lease, p_response: { text, body: { success: true, response: text } }
        });
        if (error || data !== true) throw new Error("Execution ownership unavailable");
      };
      let renewing = false;
      const heartbeat = setInterval(async () => {
        if (completed || renewing) return;
        renewing = true;
        try {
          const renewal = await client.rpc("zentra_renew_request", lease);
          if (renewal.error || renewal.data !== true) console.error("[operations] Unable to renew reservation");
        } catch (_) {
          console.error("[operations] Unable to renew reservation");
        } finally { renewing = false; }
      }, 30000);
      heartbeat.unref?.();
      res.once("finish", () => clearInterval(heartbeat));
      res.once("close", () => clearInterval(heartbeat));
      const finish = async (response, successful) => {
        if (completed) return;
        try {
          if (operation.externalUncertain) throw new Error("External result not confirmed");
          const { data, error } = await client.rpc("zentra_finish_request", {
            ...lease, p_response: successful ? response : null, p_success: successful
          });
          if (error) throw error;
          if (!data?.accepted) throw new Error("Reservation no longer owned");
          completed = true;
        } finally { clearInterval(heartbeat); }
      };
      req.completeOperation = async text => {
        try {
          await finish({ text, body: { success: true, response: text } }, hasUsableResponse(text));
          return true;
        } catch (_) {
          console.error("[operations] Unable to persist stream result");
          return false;
        }
      };
      req.failOperation = async () => {
        try { await finish(null, false); } catch (_) { console.error("[operations] Unable to persist failure"); }
      };
      const originalJson = res.json.bind(res);
      res.json = async body => {
        const usable = hasUsableResponse(body?.response);
        const text = typeof body?.response === "string" ? body.response : usable ? JSON.stringify(body.response) : "";
        try {
          const failedResponse = res.statusCode >= 400 || body?.success !== true || !usable;
          if ((operation.executivePremiumAttempt && (!operation.executivePremiumUsable || failedResponse))
            || (operation.reasoningPremiumAttempt && (!operation.reasoningPremiumUsable || failedResponse))) {
            await releaseFailedExecutivePremium(client, operation);
          }
          await finish({ text, body }, res.statusCode < 400 && body?.success === true && usable);
        } catch (_) {
          // A usable reasoning result is not delivered until its stage is durably stored.
          // The RPC rejects stale/completed leases if persistence actually committed.
          if ((operation.reasoningPremiumAttempt || operation.executivePremiumAttempt) && !operation.premiumReleaseAttempted) {
            try { await releaseFailedExecutivePremium(client, operation); }
            catch (_) { console.error("[operations] Unable to release failed premium reasoning"); }
          }
          console.error("[operations] Unable to persist result");
          return originalJson.call(res.status(503), { error: "La respuesta sigue pendiente de confirmacion.", code: "execution_uncertain" });
        }
        return originalJson(body);
      };
      return operationContext.run(operation, next);
    } catch (_) {
      return res.status(503).json({ error: "No se pudo validar el cupo. Intentá nuevamente." });
    }
  };
}
