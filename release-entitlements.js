import { validateAuditUrls } from "./release-audit-urls.js";

// Product configuration only; billing dates and checkout stay in their existing flow.
export const PLAN_ENTITLEMENTS = Object.freeze({
  free: Object.freeze({ actions: 20, audits: 1, maxPages: 3, monthlyPrice: 0, annualMonthlyPrice: 0, profileFields: Object.freeze([]) }),
  starter: Object.freeze({ actions: 300, audits: 5, maxPages: 5, monthlyPrice: 12, annualMonthlyPrice: 10, profileFields: Object.freeze(['profile_name', 'tone', 'response_depth']) }),
  pro: Object.freeze({ actions: 800, audits: 10, maxPages: 7, monthlyPrice: 29, annualMonthlyPrice: 25, profileFields: Object.freeze(['profile_name', 'profession', 'client_type', 'specialty', 'tone', 'response_depth', 'priorities']) }),
  agency: Object.freeze({ actions: 3000, audits: 30, maxPages: 11, monthlyPrice: 99, annualMonthlyPrice: 83, profileFields: Object.freeze(['profile_name', 'profession', 'client_type', 'specialty', 'tone', 'response_depth', 'priorities', 'advanced_instructions']) })
});
export const ANNUAL_PLAN_LABEL = "Pagá 10 meses y usá 12";

export function normalizeEntitlementPlan(value) {
  const plan = String(value || "free").trim().toLowerCase();
  return Object.hasOwn(PLAN_ENTITLEMENTS, plan) ? plan : "free";
}

export function chatPersonalization(user, profile = {}) {
  const plan = auditEntitlement(user).plan;
  const limits = { profile_name: 80, profession: 140, client_type: 180, specialty: 180,
    tone: 40, response_depth: 40, priorities: 260, advanced_instructions: 1400 };
  const result = {};
  for (const field of PLAN_ENTITLEMENTS[plan].profileFields) {
    if (Object.hasOwn(profile || {}, field) && typeof profile[field] === 'string') {
      const value = profile[field].trim().slice(0, limits[field]);
      if (field === 'tone' && !['directo', 'cercano', 'consultivo', 'comercial'].includes(value)) continue;
      if (field === 'response_depth' && !['corto', 'equilibrado', 'detallado'].includes(value)) continue;
      if (value) result[field] = value;
    }
  }
  return Object.keys(result).length ? { plan, profile: result } : null;
}

export function auditEntitlement(user, requestedPages) {
  user = Array.isArray(user) && user.length === 1 ? user[0] : user;
  if (!user || typeof user !== "object" || Array.isArray(user) || !["active", "cancelled"].includes(user.status)) {
    throw new Error("Authoritative user unavailable");
  }
  const plan = normalizeEntitlementPlan(user?.status === "active" ? user.plan : "free");
  const maxPages = PLAN_ENTITLEMENTS[plan].maxPages;
  const requested = Number(requestedPages);
  const totalPages = requestedPages !== null && requestedPages !== undefined && String(requestedPages).trim() !== ""
    && Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, maxPages) : maxPages;
  return { plan, maxPages, totalPages, internalPages: totalPages - 1, allowsManualSelection: plan !== "starter" };
}

export function validateAuditEntitlement(context, plan) {
  const scope = context?.auditScope;
  const normalized = normalizeEntitlementPlan(plan);
  if (!scope || scope.plan !== normalized) return false;
  const allowed = auditEntitlement({ plan: normalized, status: "active" }, scope.totalPages);
  if (!Number.isSafeInteger(scope.totalPages) || scope.totalPages !== allowed.totalPages
    || scope.internalPages !== allowed.internalPages || scope.allowsManualSelection !== allowed.allowsManualSelection) return false;
  const internal = context.internalPagesResult?.pages;
  const preview = context.freePreviewPagesResult?.pages;
  if (!Array.isArray(internal) || !Array.isArray(preview)) return false;
  // Preview and full evidence may describe the same Free URLs, never extra pages.
  if (internal.length > allowed.internalPages || preview.length > allowed.internalPages
    || (normalized !== "free" && preview.length !== 0)) return false;
  return validateAuditUrls(context, allowed.internalPages);
}
