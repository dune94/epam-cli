__TC_WRITER_PROFILE__

## Project context

This project has two independent codelines, each a standalone TypeScript+vitest workspace with no shared code:

- **mocka** at `/home/bradleyjerome/projects/mock3/mock-a` — ticket MOCK3-1 (fare boundary). Source under `src/`, tests under `test/`. The module under test is `src/fares.ts`, tested by `test/fares.test.ts`.
- **mockb** at `/home/bradleyjerome/projects/mock3/mock-b` — ticket MOCK3-2 (departure board). Source under `src/`, tests under `test/`. The module under test is `src/schedule.ts`, tested by `test/schedule.test.ts`.

### Conventions (verified from the codebase)

- **Module system**: ESM. Both `package.json` files set `"type": "module"`. `tsconfig.json` uses `"module": "ES2022"`, `"moduleResolution": "bundler"`, `"strict": true`.
- **Test framework**: vitest ^2.1.9. Tests import `{ describe, it, expect }` from `'vitest'` — never from `@jest/globals`.
- **Import paths in tests**: relative, e.g. `import { fareFor } from '../src/fares'` and `import { formatStops } from '../src/schedule'`. No path aliases are configured.
- **Test file naming**: `<module>.test.ts` inside the `test/` directory.
- **No vitest config file exists** in either codeline — vitest uses defaults (node environment, `*.test.ts` glob).
- **Commands**: `npm test` runs `vitest run`; `npm run build` runs `tsc --noEmit` (type-check only, no emit).
- **No external dependencies to mock**: both `fares.ts` and `schedule.ts` are pure functions with no I/O, no network, no imports beyond TypeScript builtins. Existing tests use no `vi.mock`, `vi.stubGlobal`, or `vi.hoisted`. If the story's source still has no external deps after implementation, state in `mockStrategy` that no mocks are needed and `beforeEach` is unnecessary.
- **Exported symbols** (read these from source to confirm after implementation, as the fix may change logic but not exports):
  - `fares.ts`: `Rider` type (`{ age: number; hasPass: boolean }`), `BASE_FARE_CENTS` (350), `CONCESSION_FARE_CENTS` (175), `fareFor(rider: Rider): number`, `totalFor(riders: Rider[]): number`.
  - `schedule.ts`: `Stop` type (`{ name: string; minutes: number }`), `formatStops(stops: Stop[]): string`, `totalMinutes(stops: Stop[]): number`.

### Stack traps

- `moduleResolution: "bundler"` means imports must include the `.js`-style resolution that vitest handles at runtime — but the existing tests use extensionless relative paths (`'../src/fares'`) and that works. Follow the same pattern; do not add `.ts` or `.js` extensions to import paths.
- `strict: true` is on. Any test helper that constructs a `Rider` or `Stop` object must satisfy the full type — no optional fields.

## Your ONLY output is a valid JSON object — nothing else

Output format (one object, all story IDs as keys):
{
  "<story-id>": {
    "verifiedAt": "<ISO8601 timestamp>",
    "sourceFiles": ["src/server.ts"],
    "facts": [
      "<concrete verifiable fact from source, e.g.: GET /search only — no /cheapest route exists>",
      "<exact query param names used: 'from' and 'to' not 'origin'/'destination'>",
      "<exact error shape: { error: string } with 400 status for missing params>"
    ],
    "mockStrategy": "<exact mock setup: e.g. vi.mock('<real module path from the diff>') with vi.hoisted constructor>",
    "bannedPatterns": ["<string that must NOT appear in test file>"]
  }
}

## Stories to process

__STORY_CONTEXT__

## Instructions

For each story above:

1. READ every IMPL_SOURCE_FILES path listed using your file reading tool. Read the COMPLETE file.

2. Extract FACTS — only things you can verify by reading the source:
   - Exact function/method signatures and parameter names
   - Exact HTTP route paths and query parameter names
   - Exact error message strings (copy verbatim from throw/send statements)
   - Exact return shapes (copy from return statements)
   - Alignment direction (left/right-pad) per column if it's a table story
   - Which validations exist and which do not (e.g. "adults=0 is valid — no lower-bound check")
   - The correct import path for the module under test

3. Write MOCK_STRATEGY as a single sentence describing exactly how to mock dependencies:
   - Include the exact vi.mock() path (the real path as it appears in the code under test, not a shortened form)
   - State whether to use vi.stubGlobal, vi.hoisted, or constructor mock
   - State whether beforeEach uses clearAllMocks or resetAllMocks

4. Write BANNED_PATTERNS as strings that must not appear in the test file:
   - Wrong endpoint paths that don't exist
   - Wrong parameter names
   - Wrong framework imports (@jest/globals)
   - Wrong mock paths

5. The testCriteria.facts OVERRIDE any conflicting AC. Write them as ground truth.

6. Write your JSON to: __TC_OUT_FILE__
   Use WriteFile to write the complete JSON object to that path.

CRITICAL: Output ONLY the JSON object in the file. No markdown, no explanation, no code fences.
After writing the file, output a single line: TC_WRITER_DONE