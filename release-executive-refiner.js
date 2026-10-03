export function hasUsableExecutiveRefinement(result, text) {
  return hasUsableStructuredRefinement(result, text, ['summary', 'quickWins', 'opportunityDetected', 'competitiveSnapshot']);
}

export function hasUsablePremiumReasoning(result, text) {
  return hasUsableStructuredRefinement(result, text, ['summary', 'quickWins', 'topIssues', 'recommendations']);
}

function hasUsableStructuredRefinement(result, text, keys) {
  if (!result?.ok || !['completed', undefined].includes(result.data?.status)) return false;
  try {
    const value = JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const meaningful = item => typeof item === 'string' ? Boolean(item.trim())
      : Array.isArray(item) ? item.some(meaningful)
      : item && typeof item === 'object' ? Object.values(item).some(meaningful) : false;
    return keys.some(key => meaningful(value[key]));
  } catch (_) { return false; }
}

// Both premium stages share one entitlement; the Audit/root receipt stays paid.
export async function releaseFailedExecutivePremium(client, operation) {
  if ((!operation?.executivePremiumAttempt && !operation?.reasoningPremiumAttempt) || operation.premiumReleaseConfirmed) return;
  operation.premiumReleaseAttempted = true;
  const { data, error } = await client.rpc('zentra_release_executive_premium', {
    p_user: operation.user.id, p_operation: operation.id,
    p_hash: operation.requestHash, p_lease: operation.leaseToken
  });
  if (error || data?.accepted !== true) throw new Error('Executive premium release not confirmed');
  operation.premiumReleaseConfirmed = true;
  operation.paidCounters?.delete('premium_pdf_used');
}
