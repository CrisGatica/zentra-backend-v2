# Meta Ads reinsertion: local closure

## Inspection and outcome

The reported historical omission is not present in the current active sources.
Chrome clean and Lab already include `meta-ads-adapter.js` in
`ZENTRA_CONTENT_SCRIPT_FILES`, immediately after Google Ads and before Search
Console. These lists match their manifest initial stacks exactly, including order.
No product correction was necessary. This inspection cannot establish when or by
whom the historical omission was corrected.

`ensureContentScriptReady` checks the tab and pings the receiver. A missing receiver
causes `injectZentraContentStack` to execute the same stack; concurrent callers share
the per-tab promise. A ready receiver is a no-op. SPA transitions use the existing
adapter: `getFullPageData` invokes `buildEnvironmentContext` with the current DOM,
URL and title, rather than retaining an initial campaign snapshot.

The existing guards preserve the Meta adapter function
(`__metaAdsAdapterInitialized`), the content message listener
(`__zentraContentMessageListenerAdded`), and the content watcher/observer
(`__zentraDesktopContextWatcherInitialized`). Nothing in these guards was edited.

Audit's dynamic stack is only `content.js`; it has no environment adapter stack.
No Audit synchronization was needed. Desktop was not edited.

## Files added

- `outputs/release-test-runtime/meta-ads-reinsertion.test.mjs`
- `outputs/release-test-runtime/meta-ads-reinsertion-report.md`

No application/backend files modified.

## Validation

14 groups PASS using JSDOM with actual active product scripts and mocked Chrome
transport. Both Clean and Lab cover:

- Initial and dynamic script lists identical; initial Meta context and metrics.
- Two consecutive stack reinjections retain the same adapter, listener/observer
  counts, history wrapper and one response per message.
- Campaign, ad set, ad and audience SPA states read updated URL/DOM/metrics.
- Back-view simulation (`replaceState` plus `popstate`) reads current state.
- Google Ads and Search Console retain priority; generic Web, YouTube, Studio,
  Instagram, TikTok and Analytics environment classification stays unchanged.
  This verifies the environment stack only, not every downstream platform feature.
- Actual popup readiness functions reconstruct Meta after a lost receiver;
  concurrent readiness injects once and an already-ready receiver is a no-op.
- Audit remains separate; hashes of 20 protected product/backend files stay equal.

Syntax checks: QA test and 18 active product JS files PASS.
No authenticated/live Meta Ads session was exercised. An existing ready receiver
with a manually deleted adapter registry is not the lost-receiver scenario tested.

The first test invocation stalled loading the older workspace dependency tree and
was stopped. The completed invocation used the existing `/tmp/zentra-topic-check-runtime`
JSDOM installation via `node:module` resolution hooks; no dependency was installed.

Manifests, backend, Audit/PDF/crawl and chat were not modified. Backend Git status
still matches the inherited dirty status. No push, deploy, migration or package.

**META ADS REINSERTION = CERRADO LOCALMENTE.**
