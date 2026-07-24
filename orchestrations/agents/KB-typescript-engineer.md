
- [2026-07-02T09:39:26Z] When) call `vi.stubGlobal('fetch', vi.fn())` with a fresh mock, and in afterEach call BOTH `vi.unstubAllGlobals()` AND `mockFetch.mockReset()` (or recreate `vi.fn()`) to guarantee response-bleed isola

- [2026-07-02T18:36:02Z] Before writing any *.test.ts that imports a library, verify that library is listed in package.json devDependencies. If missing, add it and run npm install before writing the test file.

- [2026-07-02T18:32:22Z] Always structure CLI entry points as: export an async main(argv: string[], env?: NodeJS.ProcessEnv) function containing all logic including validation; at module bottom, invoke it ONLY when run direct

- [2026-07-04T20:52:07Z] Verify target files exist with ls or find before writing imports; never guess paths from memory. In this project's CommonJS TypeScript setup (module='CommonJS' in tsconfig.json), relative imports must be extension-less (e.g. `./client`, NOT `./client.js`) — the .js-extension convention only applies to NodeNext/ESM module resolution, which this project does not use.

- [2026-07-04T21:35:21Z] Always register env-var validation middleware with app.use before any route definitions, so dependent routes can short-circuit with 503 when a required environment variable is missing.

- [2026-07-05T17:46:33Z] Never call process.exit() inside exported functions in cli.ts. Export `async function main(argv, env)` returning 0/1/2; call process.exit(await main(...)) only from the entry point.

- [2026-07-05T17:47:47Z] Vitest (not Jest) is this project's test framework. Inside a vi.mock() factory, use `await vi.importActual('./module')` (the factory function itself may be declared async — Vitest supports async mock factories). Do NOT use vi.requireActual — that is Jest's API and does not exist in Vitest; calling it throws a runtime error.

- [2026-07-06T10:03:05Z] Always parse the `argv` parameter passed into main(argv). Never read `process.argv.slice(2)` inside main — tests invoke main directly with custom argv arrays, breaking test control.

- [2026-07-06T10:06:40Z] Never use `if (import.meta.url === new URL(import.meta.url).href)` as a module entry-point guard — the comparison is always true (a URL to itself), so main() runs on every import including test import

- [2026-07-06T11:14:41Z] Use vi.mock() factories that export every binding the SUT uses in its exact call shape (standalone function vs class instance method), and assert each mock's type and shape after mocking.

- [2026-07-06T17:45:30Z] Always resolve mocked fetch calls to a Response-shaped object with ok, status, statusText, and a json method returning a Promise.

- [2026-07-06T17:50:20Z] Use valid module and moduleResolution pairs in tsconfig.json: CommonJS with Node, Node16 with Node16, ESNext with Bundler. Use CommonJS and Node for the stack. Mismatched pairs cause build errors.

- [2026-07-06T18:11:26Z] Use vi.fn().mockResolvedValue(value) to make a mock return a resolved Promise.

- [2026-07-06T20:31:11Z] Use `test: { passWithNoTests: true }` in vitest.config.ts or create a stub test file when no *.test.ts files exist.

- [2026-07-06T20:33:03Z] Enable globals:true in vitest.config.ts so describe, it, and expect work without imports, reducing boilerplate in test files.

- [2026-07-06T23:47:34Z] Use CommonJS-compatible patterns in src/server.ts: avoid `import.meta.url` and top-level `await`; gate listen with `if (require.main === module)`.

- [2026-07-07T02:35:30Z] Always include a non-test source file in src/ alongside any src/*.test.ts file, since tsconfig.json excludes test files from tsc --noEmit.

- [2026-07-07T19:01:34Z] Only modify or create files explicitly listed in the story's acceptance criteria. Do not touch files belonging to other stories or outside the current task scope.

- [2026-07-07T20:17:57Z] [unreviewed-fallback] Avoid using deprecated TypeScript compiler options like 'moduleResolution=node10'; use 'moduleResolution=node' instead.

- [2026-07-17T20:20:58Z] Always: Before importing a module or referencing a type/property, always read the actual source file to verify the export exists, its exact path, its properties, and its constructor/factory signatures

- [2026-07-23T01:15:16Z] Always: In tsconfig.json, always use moduleResolution 'node' (not 'node10' or 'Node10') — 'node10' was removed in TypeScript 5.x. The correct value for CommonJS + Node resolution is 'node'.

- [2026-07-23T14:30:00Z] CORRECTION to a prior entry (2026-07-23T01:17:52Z, now removed): that entry wrongly claimed 'moduleResolution: node' itself is removed and must become 'node16'/'nodenext'. Root-caused via mock1 (epam-cli orchestration test): 'node' is valid and correct through TypeScript 5.x (confirmed on 5.9.3) — it was only removed in TypeScript 7.x. The real defect was an unpinned `typescript` devDependency letting a fallback `npm install` pull latest (7.x) instead of the project's intended version. Do NOT rewrite a working tsconfig.json's moduleResolution in response to a TS5108 error — first check `node_modules/typescript/package.json`'s version; if it's 7.x and the rest of the project expects 5.x, the fix is pinning/reinstalling the correct typescript version, not changing moduleResolution.
