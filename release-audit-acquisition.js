import { auditEntitlement } from "./release-entitlements.js";
import { auditPublicUrl } from "./release-audit-urls.js";
import { sendFreeAccessBlock } from "./release-free-launch.js";

export function createAuditAcquisitionHandler({ client, release = false, isUnlimited = () => false }) {
  return async (req, res) => {
    try {
      const operation = req.body?.zentra_operation;
      if (!/^[0-9a-f-]{36}$/i.test(operation?.id || "") || !["subscription", "audit"].includes(operation?.product)) {
        return res.status(400).json({ error: "Solicitud de auditoria no valida." });
      }
      const args = { p_auth_id: req.auth.userId, p_email: req.auth.email,
        p_product: operation.product, p_operation: operation.id };
      if (!release) {
        let url;
        try { url = auditPublicUrl(operation.source); } catch (_) {
          return res.status(400).json({ error: "URL de auditoria no valida." });
        }
        url.hash = "";
        args.p_source = url.href;
      }
      args.p_lease = req.body?.lease_token || null;
      if (!release) args.p_unlimited = isUnlimited(req.auth.email);
      let entitlement;
      if (!release) {
        const access = await client.rpc("zentra_access", {
          p_auth_id: req.auth.userId, p_email: req.auth.email, p_product: operation.product
        });
        if (access.error || !access.data) throw access.error || new Error("Entitlement unavailable");
        entitlement = auditEntitlement(access.data, req.body?.requestedPages);
      }
      const { data, error } = await client.rpc(release ? "zentra_release_audit" : "zentra_acquire_audit", args);
      if (error) throw error;
      if (release) return res.json({ released: data === true });
      if (!data?.allowed && sendFreeAccessBlock(res, data)) return;
      if (!data?.allowed) return res.status(data?.reason === "in_progress" ? 425 : data?.reason === "usage_limit_reached" ? 403 : 409).json({
        error: data?.reason === "usage_limit_reached" ? "Alcanzaste el limite de tu plan." : "La auditoria sigue pendiente de confirmacion.",
        code: data?.reason || "operation_conflict"
      });
      return res.json({ success: true, lease_token: data.lease_token, entitlement });
    } catch (_) { return res.status(503).json({ error: "No se pudo validar la reserva de auditoria." }); }
  };
}
