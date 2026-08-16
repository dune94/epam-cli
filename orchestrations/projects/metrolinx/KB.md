# metrolinx knowledge base

> Moved out of the engine canonical (orchestrations/agents/KB.md.original) on 2026-08-16.
> These entries record metrolinx facts — its tickets, its vendor SDKs, its module layout.
> The engine KB is restored for EVERY project at the start of EVERY run, so an entry naming
> one client was knowledge every other project began with. Nothing is lost; it lives with the
> project whose facts it records.

## KB-012 -- 2026-07-23

**Category:** backend
**AgentRole:** implementer
**Tags:** typescript, syntax-error, mozio, promo-discount
**Trigger:** retry
**StoryRef:** AMSD-1820

When a previous attempt corrupts a TypeScript file with malformed syntax (e.g., `const appliedDiscount remainingDiscount,` missing `=` and function call), the tsc error messages point to the broken line and subsequent lines. The fix is to restore the correct syntax based on the surrounding logic — in this case `const appliedDiscount = getPreciseFloatNumber(discount.amount.value - remainingDiscount);`. The prescribed fix (using `parseDispatchLineItemKey` to strip `#return` suffix) was already correctly applied; only the syntax error from a prior bad write remained. Always verify the full file content after a write, especially when the root cause analysis prescribes a one-line change — don't accidentally corrupt adjacent lines.



## KB-014 -- 2026-07-25

**Category:** backend
**AgentRole:** backend-engineer
**Tags:** typescript, syntax-error, reconstruction, prescribed-fix, retry
**Trigger:** retry
**StoryRef:** AMSD-1820

When the orchestrator's `tsc --noEmit` gates report a syntax error at the middle of an otherwise intact function (the prescribed root-cause fix is already present and unrelated variables/types are fine), re-read the corrupted region in full and reconstruct by inferring the *intended* declarations from downstream usages. The variable names referenced later in the function (`appliedDiscount` summed into the dispatch's reported discount amount; `remainingDiscount` assigned back into `discount.amount.value` for the next iteration) are themselves a precise spec — split a single mangled expression back into the two `const` declarations the function's data flow requires. Do NOT re-derive the fix; trust the prescribed minimal fix and the surrounding code as the contract for what the mangled lines were supposed to do.


## KB-015 -- 2026-07-29

**Category:** frontend
**AgentRole:** backend-engineer
**Tags:** typescript, contentstack, live-preview, sdk-config
**Trigger:** retry
**StoryRef:** AMSD-2041

When enabling Contentstack SDK Live Preview by adding `live_preview: { enable, host }` to the `contentstack.Stack(options)` init options, the `LivePreview` type from `contentstack` (TS SDK) requires `management_token` as a required field — not optional. Including only `enable` and `host` causes `tsc --noEmit` to fail with TS2345: "Property 'management_token' is missing in type '{ enable: boolean; host: string; }' but required in type 'LivePreview'". The minimum fix is to also read `CONTENTSTACK_MANAGEMENT_TOKEN` from `process.env` and include it in the `live_preview` object. Gate the entire `live_preview` block on the presence of the management token (or preview host) so non-preview builds don't pass an empty string for `management_token`. This is a type-only requirement that the runtime SDK does not enforce but the SDK's shipped `LivePreview` TypeScript type does.


## KB-016 -- 2026-07-30

**Category:** frontend
**AgentRole:** implementation
**Tags:** react, contentstack, live-preview, context
**Trigger:** retry
**StoryRef:** AMSD-2041

When a story's execution plan conflicts with the authoritative Root Cause Analysis (e.g. plan asks to add live-preview methods to services/hooks/components but the RCA prescribes a single minimal fix in the context provider), follow the RCA: make the smallest change at the single source of truth. Also verify the SDK package exists in package.json before importing it — here `@contentstack/live-preview-utils` was not installed, so a window CustomEvent (`contentstack:live-preview-content`) subscription in the provider's useEffect achieves the same reactive setContent propagation without adding a dependency.



## KB-017 -- 2026-07-30

**Category:** frontend
**AgentRole:** impl
**Tags:** typescript, react, nextjs, contentstack, live-preview, scope-guard
**Trigger:** retry
**StoryRef:** AMSD-2041

When the scope guard restricts writes to a single file (e.g. `src/context/ContentstackContext.tsx`) but the story's prescribed fix implies creating helper hooks elsewhere, do NOT create new files — put the provider logic (useState + live-preview subscription useEffect) directly inside the permitted file, and `git mv` an existing `.ts` file to the declared `.tsx` path if the declared path differs in extension from what exists on disk. Wire the new provider at its single call site (`src/pages/_app.tsx`) with a minimal edit rather than re-architecting. Also: no Live Preview SDK was installed in this repo, so gating on `window.__CONTENTSTACK_LIVE_PREVIEW__`/iframe detection plus a `message` event listener satisfies the requirement without adding a dependency.


## KB-018 -- 2026-07-30

**Category:** frontend
**AgentRole:** impl
**Tags:** typescript, react, casing, tsconfig
**Trigger:** retry
**StoryRef:** AMSD-2041

When replacing a file with a differently-cased name (e.g. `contentstackContext.tsx` → `ContentstackContext.tsx`), the old file must be explicitly deleted. Git and some OS filesystems (case-insensitive on macOS/Windows) may not treat a write to the new casing as a replacement — both files can coexist on disk, causing TS1261 ("Already included file name differs only in casing") when `forceConsistentCasingInFileNames: true` is set in tsconfig. Always `rm` the old file after writing the new one.


## KB-019 -- 2026-07-30

**Category:** frontend
**AgentRole:** fix
**Tags:** typescript, casing, import, tsc
**Trigger:** retry
**StoryRef:** AMSD-2041

When renaming a file with different casing (e.g., `contentstackContext.tsx` → `ContentstackContext.tsx`), the old lowercase file may still exist on disk because Linux filesystems are case-sensitive and a `write_file` to the new name creates a separate file rather than replacing the old one. TypeScript's TS1261/TS1149 errors about "differs from already included file name … only in casing" indicate two files with the same name differing only in case exist simultaneously. The fix is to delete the old file (`rm`) in addition to updating all import paths to match the new casing.



## KB-020 -- 2026-07-30

**Category:** backend
**AgentRole:** fix
**Tags:** typescript, contentstack, live-preview, interface-contract
**Trigger:** retry
**StoryRef:** AMSD-2041

When constructing objects that must satisfy a vendor SDK interface (e.g., contentstack's `LivePreview`), always cross-check every required field in the dependency contract before writing the literal. The `LivePreview` interface requires `management_token` as a mandatory field — omitting it causes `TS2741`. The env var `CONTENTSTACK_LIVE_PREVIEW_MANAGEMENT_TOKEN` must be destructured from `process.env` and included in the `live_preview` config alongside `enable` and `host`.


## KB-PERSIST-AMSD-2041 -- 2026-07-30

**Category:** orchestration
**AgentRole:** any
**Tags:** inference-ladder, story-decomposition, capability-failure
**Trigger:** cross-run-synthesis
**StoryRef:** AMSD-2041

Story AMSD-2041 has failed 9 times with capability class (max iterations / empty output). It has 0 ACs. Model escalation alone has not resolved this — the story likely needs to be decomposed into smaller children (≤8 ACs each) before the next run. OpenSpec/SpecKit should split this story at Step 0 in the next pipeline run.


## KB-021 -- 2026-07-31

**Category:** backend
**AgentRole:** fix
**Tags:** contentstack, live-preview, typescript, sdk-config
**Trigger:** retry
**StoryRef:** AMSD-2041

The Contentstack SDK's `LivePreview` TypeScript interface requires a `host` property (alongside `management_token` and `enable`). Omitting `host` causes a TS2345 error when passing the options object to `contentstack.Stack()`. The `CONTENTSTACK_API_HOST` env var (already destructured in the file) can serve as the live preview host. Also, `@metrolinx/cx-shared` resolution failures during `tsc --noEmit` are caused by missing/broken installs — use the project's dynamic tools (`ensure-cx-shared-installed.sh`, `ensure-deps-and-clean-ts-cache.sh`) to fix before running tsc.


## KB-022 -- 2026-07-31

**Category:** backend
**AgentRole:** implementer
**Tags:** contentstack, live-preview, typescript, interface-augmentation
**Trigger:** retry
**StoryRef:** AMSD-2041

When a shared interface file (e.g. `ICommonContentstackConfig`) is outside your story's file scope, you can extend it locally using an intersection type (`OriginalInterface & { newField?: Type }`) in the file you CAN modify, rather than being blocked. This avoids module augmentation complexity and keeps the change minimal. Also, the Contentstack SDK's `.includeFallback()` method is the key call for live preview — it tells the SDK to return draft/unpublished content. It must be called on the query chain when `live_preview.enable` is true. The `live_preview` config on `contentstack.Stack()` initialization requires both `host` and `management_token` (not just `enable: true`) — without both, the SDK won't establish the preview connection.


## KB-023 -- 2026-08-01

**Category:** frontend
**AgentRole:** implementer
**Tags:** typescript, react, nextjs, module-resolution, file-shadowing
**Trigger:** retry
**StoryRef:** AMSD-2041

When both `X.ts` and `X.tsx` exist in the same directory, TypeScript/Node resolution picks `X.ts` first, silently shadowing the `.tsx`. A stale `ContentstackContext.ts` (missing new `livePreview`/`setLivePreview` members) shadowed the updated `ContentstackContext.tsx`, producing TS2339 errors in `useContent.ts` that looked like an interface not being exported. Fix: delete the duplicate `.ts` file rather than editing either file's types. On retry of "property does not exist on type" errors where the property clearly IS declared, check `ls` for same-basename `.ts`/`.tsx` duplicates before touching code.


## KB-024 -- 2026-08-01

**Category:** backend
**AgentRole:** fix
**Tags:** typescript, contentstack, live-preview
**Trigger:** retry
**StoryRef:** AMSD-2041

The Contentstack JS SDK's `LivePreview` interface requires three fields: `host` (string), `management_token` (string), and `enable` (boolean). Omitting `host` causes TS2741. When adding live_preview to the Stack config, always include `host` — the same API host used for `Stack.setHost()` (e.g. `CONTENTSTACK_API_HOST`) is the correct value.


## KB-025 -- 2026-08-02

**Category:** backend
**AgentRole:** implementer
**Tags:** contentstack, live-preview, typescript, retry-pattern, scope-discipline
**Trigger:** retry
**StoryRef:** AMSD-2041

Do NOT assert from memory which config key a third-party SDK consumes — call the `dependency_contract` tool, which reads the INSTALLED package and reports per key whether it is `consumed` (present in runtime source), `declared_only` (in a stale .d.ts the runtime ignores), or `absent` (a key that will silently do nothing). A previous entry here asserted a specific live-preview token key from memory; discovery against the installed package contradicted it, and agents that believed the entry wrote a key the SDK never reads. Verify, then write. Separately, and still true: when a story explicitly places a file in scope, edit it — do not refuse as out-of-scope and escalate. Deterministic warnings about files OUTSIDE the story's scope are pre-existing issues with their own handling; do not modify out-of-scope files in response.

## KB-026 -- 2026-08-02

**Category:** tooling
**AgentRole:** implementer
**Tags:** patch-application, git-apply, file-editing, verification, md5, retry-pattern
**Trigger:** retry
**StoryRef:** AMSD-2041

When applying a multi-edit rewrite (e.g. 4 files, hundreds of lines) via an in-process Python/bash loop that reads source, mutates, writes back, do NOT trust "OK" print statements between read and write — the script may crash on edit N AFTER printing "OK" for edits 1..N-1 but BEFORE the file is written, so nothing persists. The "OK" prints are misleading. Always verify post-condition with `git status` and `md5sum` against the canonical target. The reliable pattern when an upstream canonical diff is available is: (1) capture the canonical diff to a `.patch` file via `git diff <ref>`, (2) `git restore` any drift, (3) `git apply <patch-file>` — `git apply` is atomic per-file and exits non-zero with a clear hunk offset on failure, making the result easy to verify with `git diff <ref> -- <file>` and `md5sum`. This produced a byte-identical-to-canonical result (all 4 files matched `git show <ref>:<file>` md5s) on the first attempt, after the in-process anchor/replace approach had silently failed. Lesson: prefer `git apply` over in-process incremental rewriting whenever a canonical reference diff exists.

## KB-027 -- 2026-08-02

**Category:** backend
**AgentRole:** implementer
**Tags:** contentstack, live-preview, typescript, sdk-type-mismatch, jest-mocking
**Trigger:** retry
**StoryRef:** AMSD-2041

A third-party SDK's TypeScript declarations can disagree with what its runtime actually reads, in BOTH directions — a key may be declared-and-ignored, or consumed-but-undeclared. Resolve this with the `dependency_contract` tool against the installed package rather than reasoning from the .d.ts or from memory; a key that is not reported `consumed` compiles, looks right, and does nothing at runtime. Where the runtime needs a key the types omit, cast at the call site (`as unknown as <SdkType>`) and say why in a comment. Methods can be runtime-only too: if a chained method is absent from the public types but exists at runtime, it also needs a cast — and any test mock must include it, or spied calls silently fail.
