# Executive refiner: STAGING validation

## Cause and scoped correction

The Responses provider can return HTTP 200 with `status=incomplete`, all output
tokens spent on reasoning, and no visible text. The previous empty-object fallback
did not establish a usable final refinement. Generic operation refunds preserve
an Audit receipt if a sibling stage already completed; this also retained the
shared premium PDF receipt.

The final refiner now requires usable JSON content in its existing output blocks.
When the Sol attempt fails, the operation guard releases only `premium_pdf_used`
through `zentra_release_executive_premium`, before finalizing the request. The RPC
requires the registered executive stage, current request hash and lease, serializes
on the user/receipt locks, and is service-role-only. Repeated releases do not double
refund. A new billing cycle cannot lose its counters. The Audit receipt and all
unrelated counters remain unchanged.

Timeout/uncertain provider execution retains the existing fencing: releasing the
entitlement does not allow another provider execution. An unconfirmed database
release returns `execution_uncertain`, not a false success. An incomplete response
with valid, usable JSON can still be retained. Existing confirmed-error base
fallback remains available but does not retain the failed Sol entitlement.

## Deployment prerequisites (STAGING only)

1. Apply `supabase-executive-refiner.sql` after the existing release/execution
   guards, only in Supabase project `qfwmjgoiwketpkuhvixm`.
2. Set `ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS=2200` on
   `zentra-backend-v2-staging`. The code default stays 900; the final server budget
   overrides an older client requesting 900. Other stage budgets are unchanged.
3. Deploy the approved commit from `staging` only and check `/health`.

The previous test Audit counters are not retroactively edited. No new Audit or
real OpenAI call is part of this validation. Sol/xhigh, prompts, commercial rights,
Search budget and other model routes are unchanged. Whether 2200 suffices for a
real Sol/xhigh response must be verified by the next authorized real Audit.

## Local gate

- `executive-refiner-lifecycle.test.mjs`: actual route/guard with mocked provider,
  empty incomplete output, success, provider fallback, timeout, failed DB release;
  real ephemeral PostgreSQL for concurrent refunds, stale leases, cached replay,
  retry debit, billing cycle isolation and role permissions.
- Existing Audit routing, Search, JSON recovery, PDF_READY/resume, plan rights,
  quota, multi-process concurrency and Chat routing suites.

No production, main, client, UI or PDF design changes.
