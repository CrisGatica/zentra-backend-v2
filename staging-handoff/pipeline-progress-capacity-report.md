# STAGING: pipeline presentation and capacity links

## Isolation

Only the local unpacked client was edited:
`/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/STAGING/ZENTRA_AI_CHROME_LAB_STAGING`.

Client files: `popup.js`, `claude-chatbot.js`, `claude-pdf-generator.js`.
The client is outside this Git repository. This repository stores QA and this handoff,
not a deployable copy of those client edits. Reload only Zentra AI - STAGING in
`chrome://extensions`. No backend deployment is needed.

No backend functionality, prompts, models, Search budget, entitlement lifecycle,
pricing, Lemon, PDF content, manifest or production source was changed.
Pro Sol High / 5500, Agency Sol High / 6500 and Luna High recovery / 2500 remain intact.

## Audit: observed stages, not elapsed-time estimates

The existing presentation map `getProgressTimeline()` is separate from analysis.
`analyzeSEO` emits pages, structure, competition, recommendations and refinement.
The existing report orchestration emits initializing, primary, organizing, pdf and download.

| Observed stage | Milestone | One visible state |
| --- | ---: | --- |
| initializing | 5 | Preparando las paginas seleccionadas... |
| primary | 15 | Leyendo la pagina principal... |
| pages | 22 | Revisando las paginas seleccionadas... |
| structure | 30 | Revisando la estructura SEO... |
| competition | 50 | Contrastando referencias externas... |
| recommendations | 66 | Priorizando oportunidades... |
| refinement | 82 | Refinando recomendaciones... |
| organizing | 90 | Organizando el plan de accion... |
| pdf | 94 | Preparando el informe final... |
| download | 98 | Preparando descarga... |
| confirmed completion | 100 | Auditoria completada |

Actual UI copy retains Spanish accents. No counts are invented. The timer now only
eases width toward an observed milestone; it never increases the target on elapsed time.
Logo/smoke/activity remain animated. Stage changes use a 180 ms opacity transition,
disabled for reduced motion. Presentation animation failures are non-fatal.

Resume uses the existing saved phase and width, immediately showing its corresponding
copy. Replayed older stages cannot replace a later stage or reduce its width.
Existing serialized checkpoint writes and PDF_READY/completed checks are unchanged.
No new provider call, polling endpoint or resume operation is introduced.

The client does not receive individual backend Sol/recovery substage events.
Their existing await is represented by the broad refinement phase. This change does
not pretend to know more granular progress or emit fictitious image/title/recovery steps.

## Chat: real status events and pending checkpoint

| Event phase | Visible copy before content |
| --- | --- |
| initial draft | Entendiendo tu pedido... |
| context: actual page-context refresh | Leyendo el contexto disponible... |
| fast: dispatch of the actual request | Relacionando la informacion... |
| reasoning: existing stream/client refinement event | Refinando criterio... |
| executive: existing stream event | Organizando la respuesta... |

Timer-driven status rotation and delayed guide/identity rotation were removed.
Incoming internal status messages are not displayed; presentation copy comes from the
phase map. Unknown phases are ignored. Older replayed status phases do not regress.

The optional `progressPhase` field is saved in the existing pending request with its
unchanged operationId and restored before resume. Visible response content permanently
hides preparation notes/pills for that draft, including later refinement statuses.
Existing provisional draft recovery, final response, confirmed history write and pending
cleanup ordering remain unchanged. Completed history still hydrates without generation.

## Capacity

The existing offers, counts, title and main button remain unchanged, without prices.
All three internal buttons are now `Ver opciones` and call
`chrome.tabs.create({ url: 'https://tryzentra.app/#planes' })`.
Missing/obsolete checkout URLs cannot disable these CTAs. The popup is not navigated.
Normal plan checkout functions were not changed and no Lemon call was added.

## QA

New tests: observed Audit milestones and persisted resume; Chat status/presentation,
reduced motion and failed animation; all three capacity links including missing or
obsolete checkout URLs. The existing real lifecycle fixture also covers saved reasoning
status across popup close/reopen, same operation and one simulated provider/debit.
The wait diagnostic now asserts no elapsed-time advance above the actual milestone.

All providers are simulated. SQL suites use ephemeral localhost PostgreSQL only.
No remote SQL, real Audit or OpenAI request is performed. Browser visual acceptance
of the unpacked client is still a manual reload/check; DOM/lifecycle QA is automated.

Results: complete suite 101/101 PASS, no skipped/cancelled tests; final targeted
progress/lifecycle/wait suite 14/14 PASS. Node syntax checks for all three edited client
files PASS. The first full run could not resolve three QA dependencies; the rerun used
the already provisioned temporary runtime via a removable QA-only symlink. No product
dependencies were added.

Client SHA-256 at handoff:

```text
popup.js                 6f29aa054414226fe2796c93eecbfb3058f94f158c2a6f2d8f7dbffde040b207
claude-chatbot.js        8f7333c85fa3b2ddda7e6b82fc923129d757770e2f1d8b33ab109dfbba66dcb8
claude-pdf-generator.js  850c144deeb1d48d3fb2153de10aa7925af66d6f800ae358d90ec18ab29e79e3
```
