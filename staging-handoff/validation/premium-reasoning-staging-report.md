# Premium reasoning STAGING correction

## Cause and scope

The frozen client request carries max_tokens=1700. The previous backend clamp
honored that value even though the premium route default was 2200. The shared
premium release RPC authorized only executive_refiner_pdf, so an empty/failed
reasoning stage could not release its premium receipt after the root Audit
had already completed.

## Changes

- Authorized premium_reasoning_audit now uses a backend-owned 4000-token ceiling.
  Pro/Agency keep gpt-6-luna / high. Unauthorized/base routes retain their budget.
- Only completed, parseable JSON with a meaningful expected field is usable.
  HTTP 200 alone, empty output, malformed JSON and incomplete results are failures.
- Premium reasoning provider failure does not launch the old base-model fallback.
  It returns failure and releases only the shared premium_pdf_used entitlement.
- Failed stage persistence also attempts a lease-checked release. An ambiguous
  provider execution remains fenced; it does not allow automatic regeneration.
- The additive supabase-premium-reasoning.sql migration extends the existing RPC
  to reasoning while preserving row locks, receipt idempotency, cycle protection,
  stale-lease rejection and service_role-only permissions. A reasoning callback
  cannot refund an executive stage that is running or already completed.
- Premium telemetry includes effective max_output_tokens, usable_json,
  provider_status and safe incomplete_details in addition to tokens/cost.
- Executive remains gpt-6.1-sol / xhigh with STAGING ENV ceiling 5500.
  Audit/root consumption, Search maximum 3, prompts and client files are unchanged.

## Validation

80 node tests passed across the 16 relevant suites, including additional grouped
HTTP/SQL checks. Actual backend handlers were tested with mocked provider output
and ephemeral local PostgreSQL for both Pro and Agency:

- reasoning-only output, zero visible tokens, incomplete and invalid JSON;
- provider errors/timeouts and failed stage persistence;
- exactly-once concurrent refund, stale leases and downstream protection;
- successful reasoning plus executive: one net premium receipt;
- failed reasoning: zero net premium consumption, executive rejected, root paid;
- resumed/cached execution and no duplicate provider work;
- Audit routing/recovery, PDF lifecycle, Search, quotas/concurrency and Chat.

server.js syntax and git diff --check passed. No real Audit or OpenAI request ran.

## STAGING application

Applied supabase-premium-reasoning.sql only to independent Supabase project
qfwmjgoiwketpkuhvixm; SQL editor reported Success. No rows returned.
Applying this function definition does not retroactively refund historical Audits
or reset counters. A database outage that prevents both persistence and release
still returns execution_uncertain rather than claiming a confirmed refund.

Release is restricted to Git branch staging and Render zentra-backend-v2-staging.
Production/main, Lemon, pricing and extension packages are outside this change.
