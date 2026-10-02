# Chat lifecycle: local STAGING validation

Date: 2026-10-02. No backend product code, production client, models, routing,
quotas, billing, or provider execution logic changed.

## Client change outside this Git repository

File: `../STAGING/ZENTRA_AI_CHROME_LAB_STAGING/claude-chatbot.js`.
SHA-256: `c6af9bef3061b597c72bebac5089b4a50dc8abc9eb0781d1acea88bf6c7fc2b3`.
This backend commit contains QA and this handoff, NOT the client source.
Reload the existing unpacked STAGING extension to use the local fix.

- History writes return an acknowledgement; pending is cleared only on success.
- Pending stores a finalizing snapshot before the final history write.
- Reopen can finish that write locally without generation or usage refresh.
- Complete assistant entries retain operationId and lifecycle for deduplication.
- Intermediate layers are recoverable pending drafts, never completed history.
- Failure retains pending/the useful draft. Usage refresh failure cannot erase
  a delivered final response. Resume usage failure retains recoverable state.
- Final user context is included in the final history snapshot rather than
  starting an independent earlier user-only write.
- Existing pending freshness policy and backend identity/idempotency remain.

## Verification

Set `ZENTRA_CHAT_ROOT` to the isolated STAGING client, `ZENTRA_BACKEND_DIR` to
this repository, `ZENTRA_BASE` to its parent, and `ZENTRA_QA_RUNTIME` to the
local QA dependency package.json, per the existing QA runtime convention.

- `node --test staging-handoff/qa/chat-lifecycle-staging.test.mjs`: 9 PASS.
- `node --test staging-handoff/qa/usage-status.test.mjs`: 5 PASS.
- `node --test staging-handoff/qa/chat-http-429.test.mjs`: 10 PASS.
- `node --test staging-handoff/qa/chat-structured-response.test.mjs`: PASS.
- `node staging-handoff/qa/chat-gpt6-routing.test.mjs`: 24 groups PASS.
- `node staging-handoff/qa/http-boundary.test.mjs`: 15 groups PASS.
- External `chat-structured-response.test.mjs`: 8 PASS with
  `ZENTRA_CHAT_STAGING_FIX_TESTS=1 ZENTRA_CHAT_LIFECYCLE_FIX_TESTS=1`.
  The latter permits only the two intentionally changed lifecycle methods in
  the legacy function-identity guard; routing/refinement/render guards remain.
- Client syntax check and repository diff check PASS.

Provider calls are mocked. SQL integration uses only ephemeral local PostgreSQL.
Native Chrome popup destruction is simulated with independent DOM instances
and shared storage; a manual close/reopen smoke test is still required.
If both checkpoint and history storage fail, only the original operation
remains recoverable; local persistence cannot be guaranteed without storage.
No remote SQL, Render deploy, OpenAI real calls, or extension packaging.
