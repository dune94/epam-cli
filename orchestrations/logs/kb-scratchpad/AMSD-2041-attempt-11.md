CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below.

   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/services/contentstack.ts (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/context/contentstackContext.tsx (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/pages/_app.tsx (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/services/pageService.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/interface/content/page.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/hooks/useContent.ts (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/.env.local (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/.env.local.sample (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
---

Implement user story AMSD-2041: [GO, UP, MX] Live Preview of Content in CMS

## Story Description
AS a Content Author, I WANT to preview draft entries in CMS, SO THAT I can see how content will be shown on the website. This requires integrating Contentstack's Live Preview SDK for a Next.js CSR (Pages Router) application: adding a live_preview config block (enable, host) to the Stack initialization in src/services/contentstack.ts, installing and initializing @contentstack/live-preview-utils on the client side in src/pages/_app.tsx, wiring the onEntryChange callback to trigger a re-render through the existing ContentstackContext/useContent pipeline (note: per Contentstack documentation, onEntryChange takes no arguments — the re-render relies on the SDK's internal state update, not a callback parameter), and documenting the live_preview.enable and live_preview.host environment variables in .env.local.sample. Custom preview URL patterns are configured in the Contentstack dashboard (Settings > Stack > Live Preview), not via application environment variables. Limitation: Protected pages may not be previewable because the authentication gate cannot be bypassed by preview parameters.

## Acceptance Criteria
- 

## Root Cause Analysis & Prescribed Fix (AUTHORITATIVE — start here, do not re-trace)
A code investigation already traced this bug to its cause and prescribed the minimal fix below. This is the plan of record. Apply it; do NOT re-read the whole codebase to re-derive it.

The Acceptance Criteria above describe the desired END BEHAVIOR to VERIFY — they are NOT an implementation blueprint. Do not re-architect, split values, or add new fields/abstractions to satisfy an AC literally when the prescribed minimal fix already makes that AC pass. Implement the fix below; the ACs are how you check you got it right.

HARD RULES:
- Make the SMALLEST change that fixes the root cause. Fewer lines of code is always better.
- REUSE existing functions. Before writing any new helper, search the repo for an existing util/parser/formatter that already does what you need (use the CodeGraph tool documented below) and call it. Writing novel code when a helper already exists is a defect to be rejected in review.

_(fix-plan, from: code-graph-detective)_

- **src/services/contentstack.ts** (`options`): This is the Contentstack Delivery SDK Stack initialization config. It currently lacks a live_preview block. Adding live_preview here enables the SDK to fetch draft/preview content. The Stack instance exported on line 91 is what live-preview-utils will wrap.
  - **Minimal fix:** Add a live_preview block to the options object (line 71): live_preview: { management_token: process.env.CONTENTSTACK_MANAGEMENT_TOKEN, enable: true, host: process.env.CONTENTSTACK_PREVIEW_HOST }. Also add CONTENTSTACK_MANAGEMENT_TOKEN and CONTENTSTACK_PREVIEW_HOST to the destructured env vars at line 23. After Stack creation on line 91, call ContentstackLivePreview.init({ stack: Stack }) from @contentstack/live-preview-utils.
- **src/context/contentstackContext.tsx** (`ContentstackContext`): This is the React context that carries all CMS content to the component tree. The onEntryChange callback from live-preview-utils must update the value of this context so that every consumer of useContent re-renders with draft content. The context value is currently a static object — it needs to become reactive to live-preview updates.
  - **Minimal fix:** The provider of ContentstackContext (wherever it renders <ContentstackContext.Provider value={...}>) must subscribe to onEntryChange from live-preview-utils and re-set the context value with the updated draft entry data. The IContentstackContext interface may need no change if the live-preview SDK merges draft data into the same shape; the provider just needs to trigger a state update that causes useContent consumers to re-render.
- **src/pages/_app.tsx** (`MyApp`): This is the root App component for the Pages Router. It is the correct place to initialize @contentstack/live-preview-utils on the client side (ContentstackLivePreview.init) and to wire the onEntryChange callback that will push draft content updates into ContentstackContext, causing re-renders through the existing useContent pipeline.
  - **Minimal fix:** In MyApp (or a dedicated wrapper component rendered inside it), call ContentstackLivePreview.init() once on mount (client-side only, guarded by typeof window !== 'undefined'). Register onEntryChange to update the ContentstackContext value so that all 20+ useContent consumers (CookiesBanner, Footer, FeatureListing, NewsListingContainer, etc.) re-render with draft content. The existing ContentstackContext and useContent hook need no changes — only the Provider's value must become reactive to onEntryChange.
- **.env.local.sample**: This file documents the required environment variables for developers. New variables needed for Live Preview (CONTENTSTACK_MANAGEMENT_TOKEN, CONTENTSTACK_PREVIEW_HOST, CONTENTSTACK_PREVIEW_ENABLED) must be documented here so the team can configure preview environments.
  - **Minimal fix:** Add entries for CONTENTSTACK_MANAGEMENT_TOKEN (Contentstack management token for live preview), CONTENTSTACK_PREVIEW_HOST (e.g., rest.contentstack.com), and CONTENTSTACK_PREVIEW_ENABLED (boolean flag to enable/disable live preview). Mirror these in the destructured env vars in src/services/contentstack.ts so the options.live_preview block can reference them.
- **src/hooks/useContent.ts** (`useContent`): This is the shared hook that 20+ components use to read CMS content from ContentstackContext. It is the downstream pipeline that onEntryChange must ultimately trigger — when the context value updates (via onEntryChange), useContent's useContext(ContentstackContext) will return the new draft data, and getContentByKey will resolve the updated paths. No code change is needed here, but it is the consumption endpoint the live-preview wiring targets.
  - **Minimal fix:** No change required in this file. It already reads from ContentstackContext via useContext. Once the Provider's value is updated by onEntryChange, getContentByKey will automatically return draft content. This hook is the reuse point — all live-preview re-rendering flows through it without modification.

## What Your Last Attempt Did
This is a diffstat, not a judgement — it is what is on disk, unedited. It is EVIDENCE, not an instruction: it does not tell you the work was right, and it does not tell you to undo it. Read it to see what you already changed, so you extend that work rather than rediscovering it or repeating it.

_(attempt-evidence, from: engine)_

The previous attempt changed these files (diffstat against origin/develop):

 .env.local.sample                                |   4 +
 jest.config.js                                   |   3 +
 package-lock.json                                | 395 ++++++++++++++++++-----
 package.json                                     |   3 +-
 src/__mocks__/contentstack-live-preview-utils.ts |  21 ++
 src/pages/_app.tsx                               |  22 +-
 src/services/contentstack.ts                     |  12 +
 7 files changed, 379 insertions(+), 81 deletions(-)
 src/services/contentstack.ts | 22 ----------------------
 1 file changed, 22 deletions(-)
 .deepeval/.deepeval_telemetry.txt | new file
 .epam/codeline-facts.json | new file
 .epam/dynamic-tools/install-missing-deps.sh | new file
 .epam/dynamic-tools/install-missing-deps.sh.reviewed | new file
 .epam/settings.json | new file
 .epam/verification.json | new file
 orchestrations/logs/agent-activity.jsonl | new file

## Reviewer Feedback — ADDRESS THESE (a prior code review requested changes)
The team-lead reviewer examined your previous attempt and requested the changes below. This is the highest priority.

A BLOCKER is a required deliverable, not advice. If a blocker says something is MISSING — a test, a file, a case — the only way to resolve it is to CREATE it; leaving it out repeats the rejection. Minimality governs HOW MUCH you write, never WHETHER you write it.

For advisory points: make the smallest edits that resolve each one, and where a point says the change is over-engineered or an existing helper would do, REMOVE the excess rather than adding more.

If you genuinely cannot satisfy a blocker — no seam exists to test against, the behaviour lives entirely in a third-party package — say so explicitly in your final message, naming the blocker and why. An unexplained omission reads as a refusal and will be rejected again.
### Advisory — apply where it makes the change smaller or clearer
- [major] The `as unknown as contentstack.Config` double cast is unnecessary and hides a real type violation. The installed contentstack SDK's `Config` interface (node_modules/contentstack/index.d.ts:55) already declares `live_preview?: LivePreview`, so no cast is needed to add the key. The cast exists only to smuggle `host: CONTENTSTACK_PREVIEW_HOST || undefined` and `management_token: ... || undefined` past the compiler — `LivePreview` requires `host: string` and `management_token: string` (non-optional). When the enable flag is true but the env vars are unset, the SDK receives `undefined` for both, with untyped runtime behavior. (src/services/contentstack.ts:81)
  - Suggested fix: Drop the cast and satisfy the real type: `...(NEXT_PUBLIC_CONTENTSTACK_PREVIEW_ENABLED === "true" ? { live_preview: { enable: true, host: CONTENTSTACK_PREVIEW_HOST, management_token: CONTENTSTACK_MANAGEMENT_TOKEN } } : {})` — empty strings satisfy `LivePreview`; or only spread the block when both values are non-empty.
- [major] `ContentstackLivePreview.init({ stackSdk: Stack, clientUrlParams: { host: CONTENTSTACK_PREVIEW_HOST || undefined } })` conflates two different hosts. Per the installed SDK's own defaults (configManager/config.default), `clientUrlParams.host` is the Contentstack APP (UI) host — default `app.contentstack.com` — used to build edit-button/visual-builder links. The REST preview host (`rest-preview.contentstack.com`) belongs only in the Stack's `live_preview.host`, which the diff already sets. Passing the preview REST host as clientUrlParams.host will generate broken edit URLs; passing `undefined` when the env var is empty is again untyped. (src/services/contentstack.ts:113)
  - Suggested fix: Remove the `clientUrlParams` override entirely (the SDK default `app.contentstack.com` is correct), or set it to the app host constant if a non-default region is needed. Keep only `stackSdk: Stack`.
- [major] Dead/misleading code: `const { livePreviewHash, isLivePreviewEnabled } = useContent();` is called inside MyApp, which renders ABOVE its own `<ContentstackContext.Provider>`. It therefore always reads the `createContext({})` default — both values are always `undefined`. Consequently `componentKey = path + "-" + (isLivePreviewEnabled ? ... : "")` is always `path + "-"` and the hash-based remount the code appears to implement never fires. (The actual re-render propagation works via the Provider value identity change, not the key.) This is ~4 lines plus a `useContent` import that do nothing. (src/pages/_app.tsx:33)
  - Suggested fix: Delete the `useContent()` call and the `isLivePreviewEnabled` ternary; keep `key={path}` as before (or, if a remount on draft change is genuinely wanted, read the values from the `livePreviewValue` state directly: `const { livePreviewHash = 0, isLivePreviewEnabled = false } = livePreviewValue;`). Fewer lines, same behavior.
- [major] SPEC advisory (plan gap, not implementer scope): the mechanism re-renders the tree on `onEntryChange`, but nothing refetches entry data. Page content flows from static `pageProps` (getStaticProps / _next/data JSON), not from the live-preview-enabled Stack at runtime; the SDK's `syncToStackSdk` only stamps the hash onto `stackSdk.live_preview` for subsequent SDK requests, of which there are none client-side. So verification criteria 'page renders the draft field values' and 'updates to show the new draft content without a full reload' are not demonstrably met by this wiring — a re-render of identical props shows identical content. The plan's own context section said the provider must 're-set the context value with the updated draft entry data', which contradicts the story note that the SDK's internal state handles it; the implementer followed the story note. This needs a plan-level decision: either onEntryChange must trigger a client-side refetch of the entry through the Stack (the pattern in Contentstack's official Next.js CSR example), or a recorded decision that the hash-remount approach was verified end-to-end in a real preview iframe. (src/pages/_app.tsx:44)
  - Suggested fix: Confirm in a real Contentstack preview session whether draft values appear; if not, have the plan amended so onEntryChange refetches the entry via the live-preview-enabled Stack and sets the context value with the returned draft data.
- [minor] `ContentstackLivePreview.onEntryChange(...)` is registered in a `useEffect(..., [])` with no cleanup. On unmount or Fast Refresh the subscription leaks and duplicates; the SDK exposes `unsubscribeOnEntryChange` (and the mock in the diff already stubs it). (src/pages/_app.tsx:44)
  - Suggested fix: Return a cleanup from the effect: `return () => ContentstackLivePreview.unsubscribeOnEntryChange();`.
- [minor] `ContentstackLivePreview.init({...})` returns a Promise (per the installed light-sdk.d.ts) that is neither awaited nor `.catch()`ed — an init failure (network, bad config) becomes an unhandled rejection in the browser. (src/services/contentstack.ts:110)
  - Suggested fix: Append `.catch(() => {})` (or log) to the init call, e.g. `void ContentstackLivePreview.init({...}).catch(console.error);`.
- [minor] `const { livePreviewHash, isLivePreviewEnabled, ...content } = useContext(...)` creates a new `content` object every render, so the `useCallback(..., [content])` dependency changes every render and the memoization is dead; every consumer's `getContentByKey` identity churns. Previously `content` was the stable context reference. (src/hooks/useContent.ts:6)
  - Suggested fix: Keep `const content = useContext(ContentstackContext);` for the callback and read the two flags from the same value without destructuring-rest: `const { livePreviewHash, isLivePreviewEnabled } = content;` — but pass the original `content` (or strip keys inside getValue's caller only if a path collision is actually possible, which `livePreviewHash`/`isLivePreviewEnabled` are not for any CMS path).
- [minor] `"lodash-es": "4.18.1"` is added as a direct, exact-pinned dependency, but nothing in the diff imports lodash-es; it is already a transitive dependency of @contentstack/live-preview-utils (`^4.18.1`). Unjustified direct deps are concision debt. (package.json:56)
  - Suggested fix: Remove the direct lodash-es entry from package.json unless there is a documented resolution conflict, in which case add a comment explaining it.
- [minor] Only 404.tsx and [[...slug]].tsx re-provide the context with the live-preview flags spread in. Any other page that renders its own `<ContentstackContext.Provider value={content}>` (the context interface suggests news/directory pages exist) will shadow the outer provider and silently drop the flags, so live-preview re-rendering will behave inconsistently across routes. Verify all Provider sites. (src/pages/[[...slug]].tsx:38)
  - Suggested fix: Audit all `ContentstackContext.Provider` usages (codegraph callers on ContentstackContext) and apply the same spread, or better: eliminate the double-provider pattern by having MyApp own the flags and pages read them via useContent without re-providing.


## Verification Criteria (what a tester will CONFIRM — your change must satisfy every one)
These are observable checks, derived from the acceptance criteria and description. They describe WHAT is observed, not how to build it. Make the minimal change that makes all of these true; your accompanying test should assert them:
- When the Live Preview SDK signals a draft entry, the page renders the draft field values — such as updated text, headings, and images — corresponding to the unpublished state of that entry.
- When the Live Preview feature is not active, the page renders all published content — headings, text blocks, images, and layout — completely and without visible errors.
- When the Live Preview SDK signals a change to a draft entry, the page updates to show the new draft content without a full browser page reload.
- When the preview environment is configured and Live Preview is active, the page renders all content and layout without visible rendering errors, broken elements, or missing sections.
- When the documented preview environment variables are set to valid values, the page loads successfully and displays draft content for entries with unpublished changes.
- For pages that require authentication, draft content preview may not render even when the Live Preview SDK signals a draft entry update.

## Codeline-Specific Facts (real, curated gotchas for THIS codeline — read before assuming local tooling behaves like a fully-configured environment)
- Local dev/pre-commit hooks require real Contentstack env vars (CONTENTSTACK_API_KEY, CONTENTSTACK_DELIVERY_TOKEN, CONTENTSTACK_ENVIRONMENT, CONTENTSTACK_BRANCH) to be set — next.config.js throws 'Missing required environment variables' at import time if they're absent, which breaks tsc/next-lint inside the husky pre-commit hook even when the source change itself is correct.
- Date/locale tests assert UTC-rendered dates (this project's CI runs in UTC) — running with a non-UTC TZ produces off-by-one-day test failures unrelated to any real code change.

## Project Tools (registered by THIS codeline — call them directly, NOT via Bash)
Each reports REAL state discovered from this repository or its installed dependencies. Call the relevant one instead of assuming — an assumption that contradicts one of these is a defect:
- codegraph_query: Query this codebase's real, static symbol index (CodeGraph) instead of grepping. Modes: "explore <domain nouns>" (START HERE for an unfamiliar bug/feature — ranked symbols + blast radius + callers/callees; use domain nouns like "discount refund", never symptom/UI words like "displayed wrong"); "helpers <term>" (ALWAYS run before writing a new function — finds existing exported util/parser/formatter/mapper functions to reuse, with exact symbol + import path); "query <symbol>" (exact definition site of a known symbol name); "callers <symbol>" (who calls this — trace a symptom back to its cause); "callees <symbol>" (what this calls — trace forward); "impact <symbol>" (blast radius if you change this symbol); "show <file> [startLine] [endLine]" (read REAL verbatim source lines — required before quoting any line as evidence, capped at 300 lines per call if no end line given). Call this iteratively (5-10 times is normal), refining your query based on each result, until you converge on the real fix site.
- resolve_test_file: Given a source file path (relative to the project root), report which test file(s) ALREADY EXIST for it on disk, checked against this codeline's real conventions — co-located __tests__/, sibling .spec/.test files, and mirrored test/ directories. Use this BEFORE creating a new test file: extending an existing test file at its real, established path is almost always correct; inventing a new path/directory is almost always wrong.
- codeline_facts: Return known, real, project-operator-curated facts and gotchas about the codeline currently being worked in — e.g. required local environment variables, known dependency quirks, test-environment requirements. These are facts that could not otherwise be discovered by reading the code alone; check this before assuming local tooling (lint, tsc, pre-commit hooks) will behave the same as in a fully-configured environment.
- git_state: Report the REAL current git state of this codeline: branch, HEAD SHA, and whether the working tree is dirty (with the list of changed files). Use this instead of assuming a clean baseline.
- check_anti_patterns: Check a piece of code you are about to write (or have just written) against this project's list of known, previously-diagnosed wrong patterns — rules operators have configured because a model has regressed to them before. Call this before finishing your implementation whenever you touch an area that might have a documented gotcha; it is advisory (nothing blocks you from writing), so treat any match as a real defect to fix, not a suggestion to weigh.
- resolve_package_symbol: Given a package name and a symbol (method/function/property), reports the symbol's REAL declared shape from the package's actually-installed .d.ts files — including whether it is an instance method requiring instantiation (e.g. `new SomeClass()`) or a direct export — and separately reports whether the package's own README documents real usage of that symbol. Use this BEFORE calling a third-party SDK method you have not seen used in this codebase: a symbol that technically exists in a .d.ts file is not the same as the package's intended, documented usage — an internal class-instance method the README never calls directly is exactly the kind of near-miss that produces code that type-checks and fails at runtime.
- dependency_contract: Before writing configuration for an installed dependency, check which option keys that dependency ACTUALLY consumes. Reports per key: "consumed" (read by the package's runtime source), "declared_only" (present only in a .d.ts type declaration — the types are STALE and the runtime ignores this key, so satisfying the type is the wrong fix), "absent" (appears nowhere — a typo or invented option), or "undetermined" (package not installed/readable). Call this whenever you add or change an options object passed to a third-party library; a key that is not "consumed" will silently do nothing at runtime.
- dependency_available: Check whether packages are usable in THIS codeline before prescribing or writing work that needs them. Reports per package: "available" (declared in the manifest and installed), "installed_undeclared" (present in node_modules but MISSING from the manifest — the build passes and real users break, never treat this as usable), "declared_not_installed", or "absent" (nowhere — a plan that requires this cannot be implemented as written; say so instead of working around it). Call this before proposing a fix that depends on any third-party package.
- scan_secrets: Examine a diff for credentials that have been PASTED INTO the code, and report them. Distinguishes a literal (a quoted, long, high-entropy value — what a leaked key looks like) from a reference (an identifier, a member expression, a process.env read — which is the correct practice and is never reported). Returns findings for you to judge; it does not block anything.

## Tests are NOT your job this turn
A dedicated test-writer agent runs immediately after your fix commits and owns the bug-reproducing test. Do NOT write, edit, or create any test file (*.test.*, *.spec.*, __tests__/). Write ONLY the fix.

This is not a suggestion you can trade against a review comment: the reviewer has been given the same rule and will not reject you for absent tests. If a prior review comment appears to demand a test, it is stale — resolve it by making the fix correct, and say in your final message that test authorship belongs to the test-writer.

Adding a test here wastes your turn budget and has caused repeated failures.

## The helper to reuse is ALREADY identified — do NOT search
The Root Cause Analysis above names the exact existing helper to reuse (`Stack`). Do NOT run CodeGraph or explore the codebase to re-find it — that wastes your turn budget. Import it, apply the prescribed minimal fix, write your file(s), and stop. Only search if you hit something the prescribed fix genuinely does not cover.

VERIFICATION CRITERIA WITH NO TEST BEHIND THEM

A deterministic check compared this story's verification criteria against the tests it actually produced. The criteria below have none. Each is followed by why nothing covers it.

  - When the Live Preview feature is not active, the page renders all published content — headings, text blocks, images, and layout — completely and without visible errors.
    The test only verifies three text fields via a hook's getContentByKey method and does not exercise images, layout, or actual page rendering for visible errors, so violations of the requirement involving those content types would not cause any test to fail.
  - When the preview environment is configured and Live Preview is active, the page renders all content and layout without visible rendering errors, broken elements, or missing sections.
    The tests only assert on hook return values via renderHook and never mount a page component or inspect rendered DOM output for layout completeness, broken elements, or missing sections.
  - When the documented preview environment variables are set to valid values, the page loads successfully and displays draft content for entries with unpublished changes.
    The tests mock the Contentstack context directly rather than setting preview environment variables, and they test a hook in isolation rather than verifying that the page loads successfully when those variables are configured.
  - For pages that require authentication, draft content preview may not render even when the Live Preview SDK signals a draft entry update.
    No test introduces authentication or asserts that draft content is withheld when the Live Preview SDK signals a draft update on a page requiring authentication.

These are findings, not accusations: a criterion may be genuinely untestable in this environment — an unreachable third-party service, a behaviour only observable in a real browser. Judge each one. If it is testable, it needs a test. If it is not, say which and why, so the gap is a recorded decision rather than an omission nobody noticed.






## Technical Notes
- files: ["src/services/contentstack.ts","src/context/contentstackContext.tsx","src/pages/_app.tsx","src/services/pageService.ts","src/interface/content/page.ts","src/hooks/useContent.ts",".env.local","src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx","src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx","src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx","src/context/contentstackContext.tsx",".env.local.sample","src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx"]
- resolved: [{"declared":"src/services/contentstack.ts","actual":"src/services/contentstack.ts","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/context/contentstackContext.tsx","actual":"src/context/contentstackContext.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/pages/_app.tsx","actual":"src/pages/_app.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/services/pageService.ts","actual":"src/services/pageService.ts","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/interface/content/page.ts","actual":"src/interface/content/page.ts","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/hooks/useContent.ts","actual":"src/hooks/useContent.ts","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":".env.local","actual":".env.local","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx","actual":"src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx","actual":"src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx","actual":"src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/context/contentstackContext.tsx","actual":"src/context/contentstackContext.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":".env.local.sample","actual":".env.local.sample","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"},{"declared":"src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx","actual":"src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx","match":"exact","verified_against":"/home/bradleyjerome/projects/metrolinx/next.metrolinx.com"}]
- unresolved: []

## Existing File Contents (injected once, deterministically — do NOT ReadFile these unless you need more than shown)

### /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/services/contentstack.ts
```
import * as Utils from "@contentstack/utils";
import contentstack from "contentstack";
import { HttpStatusCode } from "@metrolinx/cx-shared/build/src/constants/common";
import { HttpError } from "@metrolinx/cx-shared/build/src/utils/common/HttpError";
import { ContentstackDebugLevel } from "constants/contentstack";
import { IInteractiveMapsConstructionNotice } from "interface/constructionNotice";
import { IContentstackContentType } from "interface/content/contentType";
import { IContentstackPage } from "interface/content/page";
import { isTestEnv } from "utils/envs";
import { InteractiveMapsContentType } from "../constants/constructionNotice";
import {
  ICommonContentstackConfig,
  IContentstackGetEntry,
  IContentstackGetInteractiveMapsStackEntry,
  IContentstackGetSingleEntry,
  IContentstackGetSingletonEntry,
  ICreateEntryConfig,
  ICreateQueryConfig,
} from "../interface/contentstack";
import { isContentstackApiError } from "../utils/isContentstackApiError";
import logger from "./logger";

const {
  API_KEY = "",
  DELIVERY_TOKEN = "",
  INTERACTIVE_MAPS_STACK_API_KEY = "",
  INTERACTIVE_MAPS_STACK_DELIVERY_TOKEN = "",
  INTERACTIVE_MAPS_STACK_ENVIRONMENT = "",
  INTERACTIVE_MAPS_STACK_BRANCH = "",
  ENVIRONMENT = "",
  CONTENTSTACK_API_HOST = "",
  CONTENTSTACK_BRANCH = "",
  CONTENTSTACK_FETCH_TIMEOUT = "",
  CONTENTSTACK_DEBUG = "",
  CONTENTSTACK_DEBUG_LEVEL = "error",
  CONTENTSTACK_MANAGEMENT_TOKEN = "",
  CONTENTSTACK_PREVIEW_HOST = "",
  NEXT_PUBLIC_CONTENTSTACK_PREVIEW_ENABLED = "",
} = process?.env || {};

const filterDebugLevel = (item: string): item is ContentstackDebugLevel =>
  [ContentstackDebugLevel.INFO, ContentstackDebugLevel.ERROR].includes(
    item as ContentstackDebugLevel,
  );

const contentstackDebugLevel = CONTENTSTACK_DEBUG_LEVEL.split(",")
  .map((item) => item.trim())
  .filter(filterDebugLevel);

const QUERY_RESPONSE_LIMIT = 100;

if (!isTestEnv()) {
  if (!API_KEY) {
    logger.error("Contentstack API key not provided");
  }

  if (!DELIVERY_TOKEN) {
    logger.error("Contentstack delivery token not provided");
  }

  if (!ENVIRONMENT) {
    logger.error("Contentstack environment not provided");
  }

  if (!CONTENTSTACK_BRANCH) {
    logger.error("Contentstack branch not provided");
  }

  if (!API_KEY || !DELIVERY_TOKEN || !ENVIRONMENT || !CONTENTSTACK_BRANCH) {
    throw new Error("Missing required environment variables");
  }
}

export const options: contentstack.Config = {
  api_key: API_KEY,
  delivery_token: DELIVERY_TOKEN,
  environment: ENVIRONMENT,
  branch: CONTENTSTACK_BRANCH,
  ...(NEXT_PUBLIC_CONTENTSTACK_PREVIEW_ENABLED === "true"
    ? {
        live_preview: {
          enable: true,
          host: CONTENTSTACK_PREVIEW_HOST,
          management_token: CONTENTSTACK_MANAGEMENT_TOKEN,
        },
      }
    : {}),
  fetchOptions: {
    debug: CONTENTSTACK_DEBUG === "true",
    logHandler: (level, data) => {
      const logLevel = level as ContentstackDebugLevel;

      if (contentstackDebugLevel.includes(logLevel)) {
        console[logLevel]("Contentstack SDK:", level, data);
      }
    },
    // https://www.contentstack.com/docs/developers/apis/content-delivery-api#errors
    retryCondition: (error) => [408, 429, 504].includes(error.status),
    ...(CONTENTSTACK_FETCH_TIMEOUT ? { timeout: Number(CONTENTSTACK_FETCH_TIMEOUT) } : {}),
  },
};

export const Stack = contentstack.Stack(options);

if (CONTENTSTACK_API_HOST) {
  Stack.setHost(CONTENTSTACK_API_HOST);
}

const renderOption = {
  span: (node: { children: any }, next: (arg0: any) => any) => next(node.children),
};

export const excludedFields = [
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "publish_details.user",
];

class ContentstackFactory {
  private stack: contentstack.Stack;

  constructor({ stack }: { stack: contentstack.Stack }) {
    this.stack = stack;
  }

  private setCommonConfig({
    query,
    ...config
  }: ICommonContentstackConfig & {
    query: contentstack.Query | contentstack.Entry;
  }) {
    const { referenceFieldPath, cachePolicy, only, except } = config;

    if (referenceFieldPath) {
      query.includeReference(referenceFieldPath);
    }

    if (cachePolicy) {
      query.setCachePolicy(cachePolicy);
    }

    if (!Array.isArray(except) && !Array.isArray(only)) {
      query.except(excludedFields);
    }

    if (only) {
      if (Array.isArray(only)) {
        query.only(only);
      } else {
        Object.entries(only).forEach(([key, values]) => query.only(key, values as string[]));
      }
    }

    if (except) {
      if (Array.isArray(except)) {
        query.except(except);
      } else {
        Object.entries(except).forEach(([key, values]) => query.except(key, values as string[]));
      }
    }
  }

  createContentTypeQuery({
    contentTypeUid,
    lang,
    where,
    count,
    skip,
    limit,
    ...commonConfig
  }: ICreateQueryConfig) {
    const query = this.stack.ContentType(contentTypeUid).Query().language(lang).toJSON();

    if (count) {
      query.includeCount();
    }

    if (skip) {
      query.skip(skip);
    }

    if (limit) {
      query.limit(limit);
    }

    this.setCommonConfig({ query, ...commonConfig });

    if (where) {
      Object.entries(where).forEach(([key, value]) => query.where(key, value));
    }

    return query;
  }

  createContentTypeEntryQuery({
    contentTypeUid,
    lang,
    entryUid,
    ...commonConfig
  }: ICreateEntryConfig) {
    const query = this.stack.ContentType(contentTypeUid).Entry(entryUid).language(lang).toJSON();

    this.setCommonConfig({ query, ...commonConfig });

    return query;
  }
}

export const getEntry = async <T>({
  contentTypeUid,
  referenceFieldPath,
  jsonRtePath,
  lang,
  cachePolicy,
}: IContentstackGetEntry): Promise<T> => {
  const result: any = [];

  const factory = new ContentstackFactory({ stack: Stack });

  const _query = factory.createContentTypeQuery({
    contentTypeUid,
    referenceFieldPath,
    lang,
    cachePolicy,
    except: excludedFields,
    count: true,
    skip: 0,
    limit: QUERY_RESPONSE_LIMIT,
  });

  try {
    const [response, count] = await _query.find();
    result.push(...response);

    while (result.length < count) {
      const _query = factory.createContentTypeQuery({
        contentTypeUid,
        lang,
        referenceFieldPath,
        except: excludedFields,
        count: true,
        skip: result.length,
        limit: QUERY_RESPONSE_LIMIT,
      });

      const [response]: any = await _query.find();

      result.push(...response);
    }

    if (jsonRtePath) {
      Utils.jsonToHTML({
        entry: result,
        paths: jsonRtePath,
        renderOption,
      });
    }

    return result;
  } catch (e: any) {
    logger.error(
      e.message,
      `Error retrieving entries of content type: ${contentTypeUid} for lang: ${lang}`,
    );
    throw e;
  }
};

export const getSingleEntry = async ({
  contentTypeUid,
  entryUid,
  lang,
  referenceFieldPath,
  jsonRtePath,
  only,
  except,
  cachePolicy,
}: IContentstackGetSingleEntry): Promise<IContentstackPage> => {
  const query = new ContentstackFactory({
    stack: Stack,
  }).createContentTypeEntryQuery({
    contentTypeUid,
    entryUid,
    referenceFieldPath,
    cachePolicy,
    only,
    except,
    lang,
  });

  try {
    const result = await query.fetch();

    if (jsonRtePath) {
      Utils.jsonToHTML({
        entry: result,
        paths: jsonRtePath,
        renderOption,
      });
    }

    return result;
  } catch (e: any) {
    logger.error(
      e.message,
      `Error retrieving single entry: ${entryUid} of content type: ${contentTypeUid} for lang: ${lang}`,
    );
    throw e;
  }
};

export const getPageContentTypes = async (): Promise<IContentstackContentType[]> => {
  const { content_types: contentTypes = [] } = await Stack.getContentTypes({
    query: { "options.is_page": true },
  });

  return contentTypes;
};

export const findSingletonEntry = async <
  T extends Pick<IContentstackPage, "uid"> = IContentstackPage,
>({
  contentTypeUid,
  lang,
  referenceFieldPath,
  cachePolicy,
  jsonRtePath,
  only,
  except,
  where,
}: IContentstackGetSingletonEntry): Promise<T | null> => {
  const query = new ContentstackFactory({
    stack: Stack,
  }).createContentTypeQuery({
    contentTypeUid,
    referenceFieldPath,
    cachePolicy,
    only,
    except,
    where,
    lang,
    limit: 1,
  });

  try {
    const [[result]]: T[][] = await query.find();

    if (!result) {
      return null;
    }

    if (jsonRtePath) {
      Utils.jsonToHTML({
        entry: result,
        paths: jsonRtePath,
        renderOption,
      });
    }

    return result;
  } catch (error) {
    logger.error(
      `Error retrieving entry of single content type: ${contentTypeUid} for lang: ${lang}`,
      error,
    );

    throw error;
  }
};

// TODO: Move to cx-shared
export const getSingletonEntry = async ({
  contentTypeUid,
  lang,
  referenceFieldPath,
  jsonRtePath,
  only,
  except,
  where,
  cachePolicy,
}: IContentstackGetSingletonEntry): Promise<IContentstackPage> => {
  const query = new ContentstackFactory({
    stack: Stack,
  }).createContentTypeQuery({
    contentTypeUid,
    referenceFieldPath,
    cachePolicy,
    only,
    except,
    where,
    lang,
  });

  try {
    const result = await query.findOne();

    if (jsonRtePath) {
      Utils.jsonToHTML({
```
(truncated at 400 of 462 lines — ReadFile this path yourself if you need the rest)

### /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/context/contentstackContext.tsx
```
import { createContext } from "react";
import { ContentTypes } from "constants/contentstack";
import { IContentstackHeader } from "interface/content/header";
import { IContentstackPage } from "interface/content/page";
import { IDirectoryData } from "interface/directory";
import { IOnboarding } from "interface/onboarding";

export interface IContentstackContext {
  header?: [IContentstackHeader];
  footer?: [any];
  onboarding?: [IOnboarding];
  page?: [IContentstackPage];
  pagesBaseURLs?: {
    [key in ContentTypes]?: string;
  };
  directories?: IDirectoryData;
  languageAlternativePageSlug?: string[];
}

export const ContentstackContext = createContext<IContentstackContext>({});
```

### /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/pages/_app.tsx
```
import "@metrolinx/cx-shared/build/bundle.css";
import "styles/globals.css";
import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect, useState, ComponentType } from "react";
import ContentstackLivePreview from "@contentstack/live-preview-utils";
import { SessionProvider } from "next-auth/react";
import { appWithTranslation } from "next-i18next";
import { ErrorBoundary, FallbackProps } from "react-error-boundary";
import { ToastNotification } from "@metrolinx/cx-shared/build/src/components/ToastNotification/ToastNotification";
import { AppEnvironmentProvider } from "@metrolinx/cx-shared/build/src/context/AppEnvironmentContext";
import { AppImage } from "components/AppImage";
import { AppLink } from "components/AppLink";
import { ClientSideErrorFallback } from "components/ClientSideErrorFallback";
import { CommonAnalytics } from "components/CommonAnalytics";
import { SuccessfulSignInToast } from "components/SuccessfulSignInToast";
import { OnlineChatContextWrapper } from "context/OnlineChatContext";
import { UserProfileProvider } from "context/UserProfileContext";
import { useAuthRefetchInterval } from "hooks/useAuthRefetchInterval";
import { useClearStoragesOnSignOut } from "hooks/useClearStoragesOnSignOut";
import { Stack } from "services/contentstack";
import { getPathname } from "utils/url/getPathname";
import packageJSON from "../../package.json";

const initAppSettings = () => {
  window.appSettings = { version: packageJSON.version };
};

function MyApp({ Component, pageProps }: AppProps) {
  const { asPath } = useRouter();
  const { refetchInterval, isLoading, session } = useAuthRefetchInterval();
  const [livePreviewKey, setLivePreviewKey] = useState(0);

  const isSignedOut = !isLoading && !session;

  useEffect(() => {
    initAppSettings();

    const root = document.getElementById("__next");
    root?.setAttribute("tabindex", "-1");

    if (process.env.NEXT_PUBLIC_CONTENTSTACK_PREVIEW_ENABLED === "true") {
      ContentstackLivePreview.init({
        stackSdk: Stack,
        clientUrlParams: {
          host: process.env.CONTENTSTACK_PREVIEW_HOST || undefined,
        },
      });

      ContentstackLivePreview.onEntryChange(() => {
        setLivePreviewKey((key) => key + 1);
      });
    }
  }, []);

  useClearStoragesOnSignOut(isSignedOut);

  const path = getPathname(asPath);

  const componentKey = path + "-" + livePreviewKey;

  return (
    <AppEnvironmentProvider linkAs={AppLink} imageAs={AppImage}>
      <UserProfileProvider>
        <SessionProvider refetchInterval={refetchInterval} refetchOnWindowFocus>
          <OnlineChatContextWrapper>
            <ErrorBoundary
              FallbackComponent={ClientSideErrorFallback as ComponentType<FallbackProps>}
            >
              {/* The key is passed to force page update on route change in some specific cases https://github.com/vercel/next.js/discussions/22512 */}
              <Component {...pageProps} key={componentKey} />
              <SuccessfulSignInToast />
              <ToastNotification />
            </ErrorBoundary>
            <CommonAnalytics contentTypeUid={pageProps.contentTypeUid} />
          </OnlineChatContextWrapper>
        </SessionProvider>
      </UserProfileProvider>
    </AppEnvironmentProvider>
  );
}

export default appWithTranslation(MyApp);
```

### /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/hooks/useContent.ts
```
import { useCallback, useContext } from "react";
import { ContentstackContext } from "context/contentstackContext";
import { getValue } from "utils/getValue";

export const useContent = () => {
  const content = useContext(ContentstackContext);

  const getContentByKey = useCallback(
    <T>(path: string, defaultValue: T) => getValue<T>(content, path, defaultValue),
    [content],
  );

  return {
    getContentByKey,
  };
};
```

### /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/.env.local.sample
```
API_KEY=
DELIVERY_TOKEN=
ENVIRONMENT=dev
ORIGIN_DOMAIN=http://localhost:3000/
REGION=us
MANAGEMENT_TOKEN=
MANAGEMENT_TOKEN_LIVE=
CONTENTSTACK_API_HOST=cdn.contentstack.io
CLOUDINARY_DOMAIN=res.cloudinary.com
NEXT_PUBLIC_FACEBOOK_APP_ID=
AZURE_SEARCH_API_KEY=
AZURE_INDEX_NAME=
AZURE_SEARCH_ENDPOINT=
AZURE_SEARCH_SUGGEST_ENDPOINT=
AZURE_SEARCH_APIM_SUBSCRIPTION_KEY=
AZURE_SUGGESTER_NAME=suggester
AZURE_AD_B2C_TENANT_NAME=
AZURE_AD_B2C_CLIENT_ID=
AZURE_AD_B2C_CLIENT_SECRET=
AZURE_AD_B2C_PRIMARY_USER_FLOW=
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000/
MAINTENANCE_MODE=false
NEXT_PUBLIC_MAILCHIMP_FORM_URL=
CONTENTSTACK_BRANCH=nonprod
CLOUDINARY_CLOUDNAME=uatmetrolinx
NEXT_PUBLIC_GTM_ID=GTM-
SEO_INDEXING=false

CONTENTSTACK_MANAGEMENT_TOKEN=
CONTENTSTACK_PREVIEW_HOST=rest-preview.contentstack.com
NEXT_PUBLIC_CONTENTSTACK_PREVIEW_ENABLED=false

NEXT_PUBLIC_CHAT_DATA_APP_ID=
NEXT_PUBLIC_CHAT_DATA_ORG_ID=
NEXT_PUBLIC_CHAT_DATA_ORG_URL=
NEXT_PUBLIC_INCLUDE_ONLINE_CHAT=false

OCP_APIM_SUBSCRIPTION_KEY=
OCP_APIM_SUBSCRIPTION_GET_END_POINT=
OCP_APIM_SUBSCRIPTION_PUT_END_POINT=
OCP_APIM_REGISTER_TO_EVENT_AUTHORIZED_END_POINT=
OCP_APIM_REGISTER_TO_EVENT_AUTHORIZED_SUBSCRIPTION_KEY=

TRAVEL_EXPENSE_REPORT_URL=

VERCEL_LOG_DRAINS_SENDING_INTERVAL=20000
VERCEL_LOG_DRAINS_DISABLED=false
VERCEL_LOG_DRAINS_OAUTH2_SECRET=
VERCEL_LOG_DRAINS_APIM_URL=
```

## Files to Create/Modify (EXACT ABSOLUTE PATHS — start here; this list is not exhaustive)
These are the files the analysis identified. Use these exact paths for them. The list is a
STARTING POINT, not a fence: it is derived from the ticket and may be incomplete or may name
a path this repository spells differently. If your change genuinely requires another file in
this repository, write it — the only files closed to you are ones another story OWNS, and
attempting one of those returns a specific refusal saying so. Do NOT work around a refusal by
repeatedly rewriting a file you can already write; that is never the fix. When you write a
file that is not listed here, say which file and why in your final message, so the reviewer
sees the whole change.
src/services/contentstack.ts,src/context/contentstackContext.tsx src/pages/_app.tsx,src/services/pageService.ts src/interface/content/page.ts,src/hooks/useContent.ts .env.local,src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx,src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx .env.local.sample,src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx

## Dependencies
None

## Module resolution in this codeline
A bare import that names a file under any of these directories is INTERNAL source, not a dependency — never add it to the dependency manifest:
  __tests__, docs, migration-scripts, orchestrations, public, src
Source extensions here: .ts, .tsx, .js, .jsx, .mjs, .cjs
Write imports the way the existing files in this codeline write them; read a neighbouring file before inventing a path.


## Instructions
CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below.
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/services/contentstack.ts (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/context/contentstackContext.tsx (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/pages/_app.tsx (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/services/pageService.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/interface/content/page.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/hooks/useContent.ts (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/.env.local (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/.env.local.sample (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
**The content of every file listed above is already shown in ## Existing File Contents — use that, do not spend a tool call re-reading them. Use Edit for targeted changes to existing files — do NOT overwrite an existing file wholesale with WriteFile.**

1. Use the injected ## Existing File Contents above to verify what actually exists (exports, types, existing utilities) before writing any code — do not guess, and do not re-read a file already shown in full
2. Implement all acceptance criteria for this story
3. Follow the project's existing code patterns and conventions
4. Do NOT create tests unless explicitly required in acceptance criteria

After implementation, provide a brief summary of what was created/modified.

## Relevant Knowledge Base Entries
The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:

# KB — metrolinx
Persistent, cross-run knowledge for this codeline. Appended by the pipeline as agents
learn, and injected into their prompts on later runs. Never reset between runs: this is
the one store that is meant to survive.
# KB — shared
Persistent, cross-run knowledge for this codeline. Appended by the pipeline as agents
learn, and injected into their prompts on later runs. Never reset between runs: this is
the one store that is meant to survive.
Do NOT read orchestrations/agents/KB.md before writing implementation files. The relevant KB entries are already injected above.


## Available Dynamic Tools
This project has the following helper scripts, written by prior self-healing runs. Use them via the bash tool instead of repeating the equivalent steps by hand:

- `bash /home/bradleyjerome/projects/metrolinx/next.metrolinx.com/.epam/dynamic-tools/install-missing-deps.sh <args>` — Installs any bare-import packages found in a dependency's dist files that are missing from node_modules

## Execution Plan
Follow this plan step by step:
1. Add ContentStack Live Preview environment variables to `.env.local` and `.env.local.sample`: `CONTENTSTACK_PREVIEW_TOKEN`, `CONTENTSTACK_PREVIEW_ENVIRONMENT`, `CONTENTSTACK_APP_HOST`, and `CONTENTSTACK_LIVE_PREVIEW_ENABLE` (boolean).

2. Modify `src/services/contentstack.ts` to import `livePreview` config from `@contentstack/delivery-sdk` (or `contentstack` SDK), and pass a `live_preview` object (`{ enable: true, preview_token, host }`) into the `Stack` initialization so all queries support preview mode.

3. Update `src/interface/content/page.ts` to add a `LivePreviewConfig` interface (`{ preview_token?: string; live_preview?: string; environment: string }`) and extend the existing page-fetch parameter types to include an optional `preview` field of this type.

4. Modify `src/context/contentstackContext.tsx` to add preview state: `previewToken`, `livePreviewHash`, and `isPreviewMode` to the context value, plus a `setPreviewState` setter; initialize values from `window.location.search` (e.g., `live_preview` query param) and `process.env.CONTENTSTACK_PREVIEW_TOKEN`.

5. Update `src/pages/_app.tsx` to wrap the app in the `ContentstackProvider` (if not already), and on mount call `ContentstackLivePreview.init({ stackSdk: contentstackStack, stackDetails: { apiKey }, clientUrlParams: { host }, editUrl: appHost })` from `@contentstack/live-preview-utils`; ensure cleanup on unmount.

6. Modify `src/services/pageService.ts` in every fetch function (e.g., `getPage`, `getPages`) to accept an optional `preview` parameter and, when present, chain `.includeLivePreview()` or append `live_preview` and `preview_token` query params to the ContentStack query.

7. Update `src/hooks/useContent.ts` to consume `useContentstackContext()` and return `{ ...existingData, isPreviewMode, livePreviewHash }` so components can react to preview state changes and trigger re-fetches when the hash changes.

8. Modify `src/components/contentstack/ContentStackGallery/ContentStackGallery.tsx`, `src/components/contentstack/ContentStackStaticMaps/ContentStackStaticMaps.tsx`, `src/components/contentstack/ContentStackVideoPlayer/ContentStackVideoPlayer.tsx`, and `src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx` to add `data-cslp` attributes (ContentStack Live Preview field-path markers) to their root rendered elements so individual fields are editable in the CMS preview.

9. Verify the integration by running the dev server (`npm run dev`), opening a page with `?live_preview=<hash>&content_type_uid=<type>&entry_uid=<id>` in the URL, and confirming that draft content from ContentStack's CMS renders in real time and that field-level edit overlays appear on the gallery, maps, video player, and quote components.