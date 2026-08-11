# KB — gotransit

Persistent, cross-run knowledge for this codeline. Appended by the pipeline as agents
learn, and injected into their prompts on later runs. Never reset between runs: this is
the one store that is meant to survive.

- [2026-08-09T17:01:50Z] Always: The contentstack SDK's LivePreview interface requires { host: string; management_token: string; enable: boolean } — use management_token not preview_token, and host is required not optional.

- [2026-08-09T18:00:45Z] Always: The contentstack SDK's Query and Entry classes do not have a livePreview() method in their TypeScript definitions — use (query as any).livePreview() to bypass. Also add live_preview?: boolea

- [2026-08-09T18:51:13Z] Always: The file src/constants/contentstack.ts does NOT export CONTENTSTACK_DEFAULT_PREVIEW_HOST. You must add `export const CONTENTSTACK_DEFAULT_PREVIEW_HOST = "https://cdn.contentstack.io";` to src/

- [2026-08-09T21:31:58Z] Always: DO import and use the existing `options` export from `src/services/contentstack.ts` (line 55) — it already encapsulates api_key, delivery_token, environment, branch, and fetchOptions. Do NOT

- [2026-08-09T22:06:54Z] Always: DO import and use the existing `options` helper from `src/services/contentstack.ts` (line 55: `export const options`) — it already constructs the Contentstack SDK config from env vars. Do NO

- [2026-08-10T00:10:39Z] Always: DO add live_preview?: boolean to IContentstackGetEntry, ICreateQueryConfig, and ICreateEntryConfig in src/interface/contentstack.ts before destructuring live_preview from those types. DON'T de

- [2026-08-10T00:13:09Z] Always: Do import { options } from "@/services/contentstack" (or the correct relative path to src/services/contentstack.ts) and use it directly — do NOT re-implement the api_key/delivery_token/envir

- [2026-08-10T00:20:36Z] Use the existing options export from src/services/contentstack.ts instead of re-implementing the Contentstack configuration objects, and pass it directly to contentstack.Stack() or live-preview configurations.

- [2026-08-10T03:11:19Z] Always: The Contentstack SDK's `LivePreview` interface requires `host: string` and `management_token: string` as non-optional fields. Do NOT use `|| undefined` when assigning these — pass the string

- [2026-08-10T04:03:55Z] Always: When passing live_preview to contentstack.Stack() Config, the SDK's LivePreview interface requires ALL of { enable: boolean, host: string, management_token: string } — { enable: true } alone

- [2026-08-10T16:20:57Z] [unreviewed-fallback] Do NOT use `import { onEntryChange } from "@contentstack/live-preview-utils"` — it is not a named export. Use `import ContentstackLivePreview from "@contentstack/live-preview-utils"` and call `Content
