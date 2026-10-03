# Executive recovery STAGING

## Contract

- Backend authority: Pro uses gpt-6.1-sol / high / 5500; Agency uses the
  same model/effort / 6500. The final decision's Agency ceiling takes precedence
  over the contradictory 5500 test bullet. Legacy ENV/client budgets and model
  overrides cannot change the authorized provider request.
- Direct completed usable Sol JSON needs no recovery.
- Incomplete or unparseable Sol with visible output permits one gpt-6-luna /
  high / 2500 repair. It receives only visible output, the existing JSON contract
  and the existing minimum structured context, never reasoning items, page
  crawl, Search or a second reasoning analysis. Original Sol prompt is unchanged.
- Failed/empty Sol or failed repair leaves the existing client fallback to the
  previous Audit result intact. No automatic Sol retry or full Audit rerun.

## Lifecycle and accounting

The additive supabase-executive-recovery.sql migration stores two phase journals
under the existing executive audit step context. Claims/checkpoints lock the
user/request/stage and require current ownership. Done phases replay from their
checkpoint, including terminal failures. The same operation and shared premium
receipt are retained. Service-role-only RPCs do not expose public mutation APIs.

A popup close does not cancel backend execution. After a durable Sol checkpoint,
an expired parent lease may resume at recovery without executing Sol again.
Provider-started crashes with no durable result are terminal uncertainty for that
phase, never permission to repeat a possibly paid request. A late stale worker
cannot overwrite/refund a new owner. This cannot reconstruct output lost before
checkpoint persistence; such work fails safely rather than being recharged.

Sol direct or successful recovery keeps one premium unit. Final unusable/error
or failed stage persistence uses the existing fenced exactly-once premium
release. Root Audit consumption remains intact. A DB outage that prevents both
persistence and release remains execution_uncertain, not a claimed refund.

## Observability

AUDIT COST distinguishes executive_refiner and executive_refiner_recovery, with
model, effort, effective ceiling, tokens/cache/reasoning/visible usage, status,
incomplete reason, usable JSON and estimated cost. AUDIT EXECUTIVE RECOVERY logs
the safe operation hash, trigger/reason, partial-output reuse and final result
sol_direct / luna_recovered / premium_failed. No content is logged.

## Local gate

Complete QA runner: 97/97 Node tests passed, including internally grouped SQL,
quota/concurrency, Lemon, routing, Search, Chat and PDF/resume checks. Real
ephemeral PostgreSQL; Auth/provider responses simulated. No real Audit or OpenAI
call. Both plans exercise actual handlers: partial -> one repair -> net 1/0,
replay without more provider calls; both ceilings/High survive legacy ENV.
Dedicated lifecycle suite: 25/25, including checkpoints, crash boundaries,
concurrent claims, stale callbacks, usable recovery and premium rollback.

QA-only harness maintenance: audio route extraction now stops before the Lemon
initializer instead of accidentally executing unrelated code. Existing SQL
fixtures load the new migration. Runtime dependencies are external/local and
not committed. Production/main, client sources, prompts, Search and billing
implementation are unchanged. Recovery semantic fidelity and the 2500 ceiling
still require later real-provider validation; mocks cannot certify them.
