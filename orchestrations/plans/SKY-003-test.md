# Execution Plan: SKY-003-test

## Story Summary
**ID:** SKY-003-test  
**Title:** Implement flight search CLI entry point with formatted table output — Tests  
**Role:** test-engineer  
**Working Dir:** `/home/bradleyjerome/projects/skyscanner-app`  
**Target File:** `src/cli.test.ts`  
**Dependency:** SKY-002 (completed ✓), SKY-003-impl (cli.ts exists ✓ but has defects)

The story requires creating `src/cli.test.ts` with at least 9 passing vitest tests that cover argument validation, table rendering, empty results, missing env var, and error handling — with `SkyscannerClient` mocked at the module boundary.

---

## 1. Implementation Steps

### Step 1: Rewrite test file with module-boundary mocking strategy
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Replace the current spawn-based integration test approach with proper vitest `vi.mock()` at the module boundary. The current tests spawn child processes (`npx tsx cli.ts`) which: (a) cannot be mocked at the module boundary, (b) make real API calls when `MOCK_SKYSCANNER_API` isn't set, (c) are slow (~3s per test). Switch to importing `main()` directly and mocking `SkyscannerClient` via `vi.mock('./skyscanner/client.js')`.
- **Rationale:** AC-13 explicitly requires "SkyscannerClient mocked at the module boundary." The spawn approach cannot satisfy this.

### Step 2: Set up test harness — process.exit/stdout/stderr interception
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** In `beforeEach`: (a) `vi.spyOn(process, 'exit').mockImplementation((code?: number) => { throw new ProcessExitError(code) })` where `ProcessExitError` is a custom error class that captures the exit code; (b) `vi.spyOn(process.stdout, 'write').mockImplementation(() => true)` and `vi.spyOn(process.stderr, 'write').mockImplementation(() => true)` to capture output; (c) save/restore `process.argv` and `process.env.RAPIDAPI_KEY`. In `afterEach`: restore all spies.
- **Rationale:** `cli.ts` calls `process.exit()` in multiple paths — without interception, vitest runner terminates. The `ProcessExitError` pattern allows asserting exit codes.

### Step 3: Write test (1) — missing `--from`
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Set `process.argv = ['node', 'cli.js', '--to', 'JFK', '--date', '2025-09-01']`. Call `main()`, catch `ProcessExitError`. Assert exit code 2, stderr contains `--from`, stdout is empty.
- **AC mapping:** AC-3

### Step 4: Write test (2) — missing `--to`
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Set `process.argv = ['node', 'cli.js', '--from', 'LHR', '--date', '2025-09-01']`. Assert exit code 2, stderr contains `--to`, stdout empty.
- **AC mapping:** AC-3

### Step 5: Write test (3) — missing `--date`
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Set `process.argv = ['node', 'cli.js', '--from', 'LHR', '--to', 'JFK']`. Assert exit code 2, stderr contains `--date`, stdout empty.
- **AC mapping:** AC-3

### Step 6: Write test (4) — invalid `--date` format
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Set `process.argv = ['node', 'cli.js', '--from', 'LHR', '--to', 'JFK', '--date', '01-01-2024']`. Assert exit code 2, stderr has human-readable message, stdout empty.
- **AC mapping:** AC-4

### Step 7: Write test (5) — invalid `--adults` value
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Set `process.argv = ['node', 'cli.js', '--from', 'LHR', '--to', 'JFK', '--date', '2025-09-01', '--adults', 'abc']`. Assert exit code 2, stderr has human-readable message, stdout empty.
- **AC mapping:** AC-5

### Step 8: Write test (6) — missing `RAPIDAPI_KEY`
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Delete `process.env.RAPIDAPI_KEY`, set valid argv. Assert exit code 1, stderr contains `RAPIDAPI_KEY`, stdout empty.
- **AC mapping:** AC-7

### Step 9: Write test (7) — multi-row table rendering
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Mock `searchFlights` to return 2+ itineraries. Capture stdout. Assert: (a) header row has columns in fixed order `Airline | Price | Departure | Arrival | Duration | Stops`, (b) separator row present with each segment's hyphen count matching its column width, (c) Price column is right-aligned, (d) delimiter is ` | ` (space-pipe-space).
- **AC mapping:** AC-8, AC-9

### Step 10: Write test (8) — empty-array result
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Mock `searchFlights` to return `{ status: 'success', data: { context: { status: 'complete', totalResults: 0 }, itineraries: [] } }`. Assert stdout is exactly `No flights found.`, exit code 0.
- **AC mapping:** AC-11

### Step 11: Write test (9) — error path (client throws)
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts`
- **Action:** Mock `searchFlights` to reject with `new Error('API failure')`. Assert stderr contains `API failure`, exit code 1, stdout empty.
- **AC mapping:** AC-12

### Step 12: Verify all tests pass and no new dependencies added
- **Action:** Run `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run` and confirm exit 0 with all 9+ tests green. Verify `package.json` has no new dependencies.
- **AC mapping:** AC-14, AC-15

---

## 2. Dependency Validation

| Dependency | Status | Reason |
|---|---|---|
| SKY-001 (scaffold) | ✅ Satisfied | `package.json`, `tsconfig.json`, `vitest.config.ts`, `node_modules/` all exist at `/home/bradleyjerome/projects/skyscanner-app/` |
| SKY-002 (API client) | ✅ Satisfied | `src/skyscanner/client.ts` exists with `SkyscannerClient`, `SearchParams`, `SearchResponse` exports; 8 tests passing |
| SKY-003-impl (cli.ts) | ⚠️ Partially satisfied | `src/cli.ts` exists and compiles, BUT has **critical defects** vs ACs (see Risk #1, #2) |
| vitest infrastructure | ✅ Satisfied | vitest 1.6.1 installed, `vitest.config.ts` configured with `globals: true` |
| TypeScript compilation | ✅ Satisfied | `tsc --noEmit` passes cleanly |

---

## 3. Risk Register

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| 1 | **cli.ts separator row uses wrong delimiter** — `buildTable()` joins separator segments with `-+-` instead of ` | ` (space-pipe-space). AC-8 requires ` | ` delimiter for ALL rows including separator. Tests asserting ` | ` on the separator will fail against current impl. | 🔴 High | Certain | **Escalate to SKY-003-impl** to fix `buildTable()` separator join from `'-+-'` to `' | '`. If impl cannot be changed, tests must document the discrepancy with a `// TODO: AC-8 requires " | " delimiter on separator row` annotation and test against actual behavior. **Preferred: escalate defect.** |
| 2 | **cli.ts requires `originEntityId`/`destinationEntityId` in SearchParams** — the current `main()` hardcodes `originEntityId: parsed.from!` and `destinationEntityId: parsed.to!` (using the same value as the skyId). The ACs only list `--from`, `--to`, `--date` as required flags. The existing test file tests for `--from-entity`/`--to-entity` which don't exist in the current `parseArgs()`. Tests must use the actual CLI's flag set (`--from`, `--to`, `--date`, `--adults`) and not invent flags. | 🟡 Medium | High | Write tests matching the **actual CLI behavior** (only `--from`, `--to`, `--date`, `--adults`). The entity IDs are derived internally from `--from`/`--to` values, not from separate flags. This is consistent with AC-3. |
| 3 | **`process.exit` interception** — `cli.ts` calls `process.exit(0)`, `process.exit(1)`, `process.exit(2)` in multiple code paths. If `vi.spyOn(process, 'exit')` doesn't properly prevent termination, vitest runner will crash. | 🟡 Medium | Medium | Use `mockImplementation((code) => { throw new ProcessExitError(code) })` pattern so the exit code can be captured from the thrown error. Wrap `main()` calls in try/catch. This is a well-established vitest pattern. |

---

## 4. Test Plan

### New Tests Required (in `src/cli.test.ts`)

| Test # | Name | What it verifies | AC |
|---|---|---|---|
| 1 | missing --from flag | exit 2, stderr mentions --from, stdout empty | AC-3 |
| 2 | missing --to flag | exit 2, stderr mentions --to, stdout empty | AC-3 |
| 3 | missing --date flag | exit 2, stderr mentions --date, stdout empty | AC-3 |
| 4 | invalid --date format | exit 2, stderr has human-readable message, stdout empty | AC-4 |
| 5 | invalid --adults value | exit 2, stderr has human-readable message, stdout empty | AC-5 |
| 6 | missing RAPIDAPI_KEY env var | exit 1, stderr contains 'RAPIDAPI_KEY', stdout empty | AC-7 |
| 7 | multi-row table rendering | header order, separator row, column widths, Price right-aligned, ` | ` delimiter | AC-8, AC-9 |
| 8 | empty result | stdout exactly 'No flights found.', exit 0 | AC-11 |
| 9 | client throws error | stderr contains error message, exit 1, stdout empty | AC-12 |

**Total: 9 tests minimum (AC-13 requires ≥ 9)**

### Regression Scope
- `src/skyscanner/client.test.ts` (8 existing tests) — must continue passing
- `tsc --noEmit` — must continue passing with zero errors
- No new dependencies in `package.json`

### Test Strategy Notes
- **Mocking approach:** Use `vi.mock('./skyscanner/client.js')` to mock `SkyscannerClient` at the module boundary (AC-13 requirement). The mock factory returns a constructor whose `searchFlights` method is a `vi.fn()`.
- **process.exit handling:** Custom `ProcessExitError` class captures exit code; `main()` calls are wrapped in try/catch.
- **stdout/stderr capture:** `vi.spyOn(process.stdout, 'write')` and `vi.spyOn(process.stderr, 'write')` to capture output without spawning child processes.
- **argv manipulation:** Override `process.argv` in each test to simulate different CLI invocations.

---

## 5. Acceptance Criteria Mapping

| AC # | Criterion | Implementation Step | Notes |
|---|---|---|---|
| AC-1 | `src/cli.ts` exists and `tsc --noEmit` reports zero errors | Step 12 (verify) | Pre-existing; just verify |
| AC-2 | `tsconfig.json` outDir=dist, CommonJS, `node dist/cli.js` works | Step 12 (verify) | Pre-existing; just verify |
| AC-3 | Missing `--from`/`--to`/`--date` → exit 2, stderr usage hint, stdout empty | Steps 3, 4, 5 | Three separate test cases |
| AC-4 | Invalid `--date` format → exit 2, stderr message, stdout empty | Step 6 | |
| AC-5 | Invalid `--adults` → exit 2, stderr message, stdout empty | Step 7 | |
| AC-6 | `adults` value forwarded to `searchFlights` | Step 9 (within happy-path test) | Verify mock called with correct adults param |
| AC-7 | Missing `RAPIDAPI_KEY` → exit 1, stderr contains 'RAPIDAPI_KEY', stdout empty | Step 8 | |
| AC-8 | Table: header order, separator, column widths, ` | ` delimiter | Step 9 | **Risk #1: separator delimiter mismatch in impl** |
| AC-9 | Price right-aligned, others left-aligned | Step 9 | |
| AC-10 | Currency symbol from API, fallback `£` | Step 9 (within table test) | |
| AC-11 | Empty array → `No flights found.`, exit 0 | Step 10 | |
| AC-12 | Error → stderr message, exit 1, stdout empty | Step 11 | |
| AC-13 | ≥9 tests covering all listed scenarios, SkyscannerClient mocked at module boundary | Steps 1–11 | Current tests use spawn, not module mock — must rewrite |
| AC-14 | `vitest run` exits 0, all green | Step 12 | |
| AC-15 | No new runtime dependencies | Step 12 (verify) | |

---

## 6. Cost/Effort Forecast

**Original estimate:** 15 hours (from PRD)  
**Recommended adjustment:** 8 hours

**Rationale for reduction:**
- The implementation (`cli.ts`) already exists — this is a test-only story
- The test file skeleton exists but needs a complete rewrite (spawn → module mock)
- 9 test cases are well-defined with clear assertions
- The main complexity is the `process.exit` interception pattern and the separator-row delimiter defect (Risk #1)
- Estimated breakdown: rewrite harness (1h), 9 test cases (3h), debugging/fixing (2h), verification (1h), escalation handling (1h)

**Confirmed estimatedHours: 8**

---

## Escalation Required

### Defect 1: Separator row delimiter in `cli.ts`
- **File:** `/home/bradleyjerome/projects/skyscanner-app/src/cli.ts`
- **Line:** In `buildTable()`, the separator is joined with `'-+-'` instead of `' | '`
- **AC violated:** AC-8 requires ` | ` (space-pipe-space) delimiter for separator row
- **Fix:** Change `headers.map((_, i) => '-'.repeat(columnWidths[i])).join('-+-')` to `headers.map((_, i) => '-'.repeat(columnWidths[i])).join(' | ')`
- **Impact:** Without this fix, test #7 (multi-row table rendering) will fail when asserting ` | ` delimiter on the separator row
