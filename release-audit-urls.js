import { BlockList, isIP } from "node:net";

const internal = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]]) {
  internal.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [["::", 96], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]]) internal.addSubnet(address, prefix, "ipv6");
internal.addAddress("::1", "ipv6");

// These URLs are evidence identifiers, not server fetch destinations. DNS/redirect
// safety still has to be enforced by whichever component actually opens a URL.
export function auditPublicUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new Error("Invalid audit URL");
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid audit URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const family = isIP(host);
  if (family ? internal.check(host, family === 4 ? "ipv4" : "ipv6") :
    !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)
      || host === "metadata.google.internal") throw new Error("Internal audit destination");
  url.hostname = family === 6 ? `[${host}]` : host;
  url.hash = "";
  return url;
}

function siteKey(url) {
  return url.hostname.replace(/^www\./, "") + ":" + url.port;
}

export function auditUrlKey(url) {
  url = typeof url === "string" ? auditPublicUrl(url) : new URL(url.href);
  // Match the existing trailing-slash rule, but retain meaningful query values
  // and path casing. Tracking-only parameters do not identify another page.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  }
  return siteKey(url) + (url.pathname.replace(/\/+$/, "") || "/") + url.search;
}

export function validateAuditUrls(context, internalLimit) {
  try {
    const target = auditPublicUrl(context.pageData?.url);
    const scope = siteKey(target);
    const within = value => {
      const url = auditPublicUrl(value);
      if (siteKey(url) !== scope) throw new Error("Audit URL outside target site");
      return url;
    };
    const primary = auditUrlKey(target);
    if (context.pageData.requestedUrl) within(context.pageData.requestedUrl);
    if (context.pageData.domain && String(context.pageData.domain).toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
      !== target.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")) return false;
    const selected = new Set();
    for (const pages of [context.internalPagesResult.pages, context.freePreviewPagesResult.pages]) {
      const seen = new Set();
      for (const page of pages) {
        within(page.url);
        const requested = within(page.requestedUrl || page.url);
        const key = auditUrlKey(requested);
        if (key === primary || seen.has(key)) return false;
        seen.add(key);
        selected.add(key);
      }
    }
    for (const result of [context.internalPagesResult, context.freePreviewPagesResult]) {
      const attempts = result.acquisition?.attempts;
      if (attempts !== undefined) {
        if (!Array.isArray(attempts) || attempts.length > internalLimit) return false;
        for (const attempt of attempts) {
          if (!selected.has(auditUrlKey(within(attempt.url)))) return false;
        }
      }
      for (const error of result.errors || []) {
        if (error.url && !selected.has(auditUrlKey(within(error.url)))) return false;
      }
    }
    return selected.size <= internalLimit;
  } catch (_) { return false; }
}
