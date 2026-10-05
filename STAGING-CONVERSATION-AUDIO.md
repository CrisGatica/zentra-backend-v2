# Conversation Audio — STAGING only

## Isolation / operation

The HTTP layer accepts only a verified, email-confirmed Supabase session. Audio routes
are closed unless `SUPABASE_URL` is exactly the STAGING project URL and the database
feature flag `zentra_conversation_audio_settings.enabled` is true. The migration creates
the flag **false**. It can be disabled without a deployment by updating that row from
the STAGING SQL Editor. No production deployment or configuration is authorized.

Endpoints: authenticated GET `/api/conversation/audio/config`; POST
`/api/conversation/audio/prepare`; POST `/api/conversation/audio/process`.

Prepare accepts a bounded generic `zentra.conversation.v1` snapshot and a UUID.
It does not claim a Free slot, consume an action, download audio or call a provider.
The server stores its hash plus platform/contact/message-ID binding, not conversation
text, signed media URLs, cookies or binaries. Process requires explicit user authorization.

## Browser transport / native priority

Only the STAGING extension registers the transport. It re-extracts the active tab's DOM,
checks the same URL/contact/message identity and rejects native transcripts, available
native transcription, unknown capability, unapproved hosts and redirects. It fetches
the message's existing HTTPS audio resource using the normal browser session. Cookies
are never read manually or sent to Zentra. It checks the active tab again after retrieval.
Only the authenticated STAGING API receives the bounded binary payload. No playback,
private platform API, traffic interception, debugger or manifest change.

Respond currently documents native transcription for incoming voice notes. The inspected
outgoing voice-note row exposes no native transcription control. Incoming notes stay
native-first even if the control isn't currently visible; outgoing notes with a visible
native control also stay native-first. Unknown future adapters fail closed. Transport
currently supports only observed Respond media hosts; WhatsApp/Bird transport is NOT
implemented. Their future adapters must establish native capability and resource scope.

## Authoritative duration, minutes and actions

Formats are identified from bytes by pinned `music-metadata`. Pinned `ffmpeg-static`
decodes locally through stdin/stdout with only the pipe protocol, one thread and a
30-second deadline, discarding PCM immediately. Duration is counted from decoded samples
to millisecond precision, not client duration or editable container/Xing headers. This
does not play audio or write files. No bin survives the HTTP request.

Hard limits: 600,000ms/audio, 900,000 new ms/operation, 5 new audios/operation;
25MB/file and 32MB total payload bytes (existing JSON boundary: 50MB).
Selection favors recent missing audio; exclusions are reported. Actual bytes exceeding
the limits reject the operation before any transcription provider call, never silently
process the whole set.

Monthly limits: Free 600,000ms; Starter 3,600,000ms; Pro 14,400,000ms;
Agency 60,000,000ms. The DB chooses plan/cycle from the verified account. Paid accounts
use the existing monthly billing cycle; Free uses its monthly anchored cycle without
resetting lifetime Free Launch counters. Downgrades/cycle changes are rechecked at start.

The existing Chat debit remains one. An audio operation uses exactly one additional
`actions_used` receipt, immediately at the fenced provider-start boundary, regardless
of the number of newly transcribed audios. Prepare/confirmation/native/no-work/cache
paths use no extra action. The server leaves room for the ordinary Chat analysis action.
Successful transcripts transfer actual milliseconds from reserved to used. Uncertain
provider outcomes hold minutes reserved rather than inventing successful processing.

## Persistence / idempotency

New private tables (RLS, no anon/authenticated access; service role only):

- `zentra_conversation_audio_settings`: singleton / enabled.
- `zentra_audio_usage`: user / monthly cycle / used_ms / reserved_ms.
- `zentra_audio_operations`: user / UUID / request_hash / minimal binding / selection /
  state / action_charged / created_at.
- `zentra_audio_cache`: user / stable audio_key / binary SHA-256 / operation /
  duration_ms / cycle / state / transcript / created_at.

The stable identity hashes authenticated user + platform + contact ID + message ID,
not temporary URLs. Binary fingerprints catch duplicates across different message IDs.
User-row transaction locks serialize independent workers; retry/double-click cannot
start the same audio twice. Cache reuse does not consume minutes or a processing action,
including across billing cycles. Client storage contains only opaque operation IDs/hashes.

Provider-started timeout/crash/storage failure is held `uncertain`; it is never retried
automatically. An operator must reconcile uncertain attempts, never reset blindly.
Unstarted stale minute reservations may be released safely after 15 minutes. Prepared
operations expire after 30 minutes. Cache contains transcripts and minimal metadata;
no retention/deletion job is silently introduced by this change.

Conversation membership means the selected ID belongs to the validated, frozen snapshot.
Without a platform API, the server cannot independently attest that DOM evidence belongs
to a real platform account; it never treats that evidence as privileged instructions.

## Context / provider / telemetry

The original message becomes `audio_transcript`, retaining ID, direction, sender,
timestamp and order, with `source: zentra_transcript` and `audio_id`. The trusted builder
continues quoting it as untrusted user evidence, never system instructions, capped at
60 messages / 6000 serialized characters. No routing, vision, summary-model or Audit change.

Provider: `gpt-transcribe`, `/v1/audio/transcriptions`, `languages[]=es`, no conversation
instructions as a transcription prompt. Official reference:
https://developers.openai.com/api/docs/guides/speech-to-text

Telemetry contains only operation ID, counts, milliseconds, cache hits, quota before/after,
model and estimated cost when known. No transcript, conversation, media URL or credential.

## Verification

Offline tests use synthetic PCM WAV and a mocked transcription provider with real local
PostgreSQL. No private audio, OpenAI, Search, purchase or production request.

Run `node --test --test-concurrency=1 staging-handoff/qa/*.test.mjs` with
`ZENTRA_BACKEND_DIR` pointing to this repo, `ZENTRA_CHAT_ROOT` to the STAGING extension,
and the existing `ZENTRA_BASE` / `ZENTRA_TEST_PG_MODULE` QA environment paths.

After deployment: reload **Zentra AI - STAGING** and the Respond tab. The flag stays false
until the user authorizes one real audio test; do not send Chat/Audit or activate the flag
as part of offline QA.
