# KB — gotransit

Persistent, cross-run knowledge for this codeline. Appended by the pipeline as agents
learn, and injected into their prompts on later runs. Never reset between runs: this is
the one store that is meant to survive.

- [2026-08-09T17:01:50Z] Always: The contentstack SDK's LivePreview interface requires { host: string; management_token: string; enable: boolean } — use management_token not preview_token, and host is required not optional.

- [2026-08-09T18:00:45Z] Always: The contentstack SDK's Query and Entry classes do not have a livePreview() method in their TypeScript definitions — use (query as any).livePreview() to bypass. Also add live_preview?: boolea

- [2026-08-09T18:51:13Z] Always: The file src/constants/contentstack.ts does NOT export CONTENTSTACK_DEFAULT_PREVIEW_HOST. You must add `export const CONTENTSTACK_DEFAULT_PREVIEW_HOST = "https://cdn.contentstack.io";` to src/
