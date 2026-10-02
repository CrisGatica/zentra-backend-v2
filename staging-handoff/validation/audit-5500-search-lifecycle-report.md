# STAGING: executive 5500 / Search terminal lifecycle

## Scope and cause

- Branch staging only. Production/main, clients, Lemon, prices and plan limits unchanged.
- Executive exhausted 2200 tokens before usable JSON. The general 4096 clamp would also silently reduce an ENV ceiling of 5500.
- Search middleware skipped zentra_finish_search after uncertain provider failure; the SQL begin path reported uncertainty but left the row running indefinitely.

## Runtime changes

- server.js: executive-only hard ceiling 5500; server ENV remains authoritative over legacy client budgets. Other task ceilings unchanged. Default ENV fallback remains 900, intentionally not a production configuration change.
- STAGING Render setting required: ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS=5500. Sol/xhigh, prompts, JSON and Pro/Agency authorization unchanged.
- release-audit-routing.js / server.js: safe executive telemetry adds effective max_output_tokens and usable_json, retains model/reasoning, measured usage, visible tokens, status, incomplete reason and estimated cost. Missing usage remains unknown; configured ceiling is not billed usage.
- release-executive-refiner.js: incomplete is never accepted as final premium success, even with visible JSON. Existing fenced/idempotent premium-only release is retained; Audit receipt is not refunded or regenerated.
- release-audit-steps.js: every Search response attempts persistent terminal closure. DB failure stays execution_uncertain. Startup and 60-second unref maintenance reap expired Search leases without provider calls.
- supabase-search-lifecycle.sql: incremental migration after supabase-execution-guard.sql. Adds terminal execution_uncertain, changes begin/finish, and server-only zentra_reap_search_leases(uuid). Same user-first lock ordering, current lease fencing and global budget of 3.

## Search outcomes

| Evidence | Terminal state | Budget / replay |
| --- | --- | --- |
| Complete provider response + settled actual tools | done | actual retained; unused slots released; cached result |
| Provider started, unknown actual / abort / incomplete / HTTP error | execution_uncertain | entire reserved allowance retained; no same-request regeneration |
| No provider start, preflight failure / expired unstarted lease | failed | only proven unstarted reservation released; fenced resume possible |
| Settled actual, lost result before finish | failed | actual retained; any further call limited to remaining global budget |
| Process dies | expired lease reaped on startup/minute or begin | same evidence rules; active leases untouched |

No historical unknown Search is declared unused. Cleanup is bounded to 100 users per pass, takes user locks with SKIP LOCKED, and logs counts only. Expiry is the existing five-minute lease; normal errors close immediately. Heartbeats protect legitimate live work.

## Tests

Final serial run: 74 node:test entries PASS, 0 FAIL, 0 skipped; includes the internal assertion groups printed by legacy suites.

- release-competitive-search.test.js
- staging-handoff/qa/audit-gpt6-routing.test.mjs (15 groups, real local SQL + full backend; Pro/Agency transport confirms 5500)
- staging-handoff/qa/audit-json-recovery.test.mjs (23 recovery checks + 6 output-budget checks)
- staging-handoff/qa/audit-steps.test.mjs
- staging-handoff/qa/audit-wait-diagnostic.test.mjs (9 wait/resume/PDF_READY scenarios)
- staging-handoff/qa/audit-staging-launch.test.mjs (7 telemetry/routing cases)
- staging-handoff/qa/executive-refiner-lifecycle.test.mjs (14 cases, rollback/current-cycle/concurrent leases)
- staging-handoff/qa/search-lifecycle.test.mjs (11 cases, migration applied twice to ephemeral PostgreSQL)
- staging-handoff/qa/quota.test.mjs (65 groups)
- staging-handoff/qa/quota-multiprocess.test.mjs (32 groups, new Search migration, SIGKILL + real heartbeat)
- staging-handoff/qa/plan-entitlements.test.mjs (23 groups)
- staging-handoff/qa/chat-gpt6-routing.test.mjs (24 groups)
- staging-handoff/qa/chat-lifecycle-staging.test.mjs (9 cases)
- staging-handoff/qa/chat-structured-response.test.mjs
- staging-handoff/qa/chat-http-429.test.mjs (10 cases)
- staging-handoff/qa/http-boundary.test.mjs (15 groups)

An old multiprocess assertion explicitly expected running after provider SIGKILL; updated to execution_uncertain, while retaining the same lease, budget=3, one debit and no extra execution assertions. No product logic changed to bypass a failing test.

Syntax checks: server.js, release-audit-steps.js, release-audit-routing.js, release-executive-refiner.js PASS. git diff --check PASS.

## Exact files in commit

- server.js
- release-audit-routing.js
- release-audit-steps.js
- release-executive-refiner.js
- supabase-search-lifecycle.sql
- staging-handoff/qa/audit-gpt6-routing.test.mjs
- staging-handoff/qa/audit-staging-launch.test.mjs
- staging-handoff/qa/executive-refiner-lifecycle.test.mjs
- staging-handoff/qa/quota.test.mjs
- staging-handoff/qa/quota-multiprocess.test.mjs
- staging-handoff/qa/search-lifecycle.test.mjs
- staging-handoff/validation/audit-5500-search-lifecycle-report.md

Pre-existing .DS_Store and CONFIGURAR-CLAUDE.md excluded/preserved. Temporary QA dependency symlink removed. No extension packaging or real OpenAI/Audit execution.

## Deployment gate

Apply only to Supabase STAGING qfwmjgoiwketpkuhvixm. Save only the single Render ENV on service srv-davfrfnavr4c73bro51g, then deploy the tested staging SHA. Verify LIVE, /health 200, unchanged main SHA, cleanup state and retained budget for the historical uncertain Search. No usage resets or retroactive premium refunds.

Residual: 5500 adequacy must be measured in the next user-run real Pro/Agency Audit; no claim that every xhigh response fits. Historical uncertain Search usage/cost remains unknown, not zero. Maintenance cannot run while the service is suspended; it runs again on startup.
