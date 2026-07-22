# Execution Plan: SKY-003-test

## Story Summary
**ID:** SKY-003-test  
**Title:** Flight search CLI entry point with formatted table output — Tests  
**Role:** test-engineer  
**Working Dir:** `/home/bradleyjerome/projects/skyscanner-app`  
**Target Files:** `src/cli.test.ts`, `src/table.test.ts`  
**Dependencies:** SKY-001 (scaffold ✓), SKY-002 (SkyscannerClient ✓), SKY-003-impl (cli.ts exists ⚠️ has defects)

The story requires creating `src/cli.test.ts` (≥9 tests) and `src/table.test.ts` (≥5 tests) covering argument validation, table rendering, empty results, missing env var, and error handling — with `SkyscannerClient` mocked at the module boundary via `vi.mock()`.

---

## 1. Implementation Steps with Target File Paths

| Step | Description | Target File | Depends On |
|------|-------------|-------------|------------|
| 1 | Create test harness: `ProcessExitError` class, `vi.spyOn(process,'exit')`, `vi.spyOn(process.stdout,'write')`, `vi.spyOn(process.stderr,'write')`, save/restore `process.argv` and `process.env.RAPIDAPI_KEY` in beforeEach/afterEach | `src/cli.test.ts` | — |
| 2 | `vi.mock('./skyscanner/client')` — factory returning `{ SkyscannerClient: vi.fn() }` with mock `searchFlights` method | `src/cli.test.ts` | Step 1 |
| 3 | Test: missing `--from` → exit 2, stderr contains `--from`, stdout empty | `src/cli.test.ts` | Step 2 |
| 4 | Test: missing `--to` → exit 2, stderr contains `--to`, stdout empty | `src/cli.test.ts` | Step 2 |
| 5 | Test: missing `--date` → exit 2, stderr contains `--date`, stdout empty | `src/cli.test.ts` | Step 2 |
| 6 | Test: invalid `--date` format (e.g. `01-01-2024`) → exit 2, stderr message, stdout empty, no network call | `src/cli.test.ts` | Step 2 |
| 7 | Test: invalid `--adults` (non-integer `1.5`, ≤0 `0`, non-numeric `abc`) → exit 2, stderr message, stdout empty | `src/cli.test.ts` | Step 2 |
| 8 | Test: missing/empty `RAPIDAPI_KEY` → exit 1, stderr contains `RAPIDAPI_KEY`, stdout empty, no network call | `src/cli.test.ts` | Step 2 |
| 9 | Test: flag order independence — `--to JFK --from LHR --date 2025-09-01` produces same `searchFlights` call as `--from LHR --to JFK --date 2025-09-01` | `src/cli.test.ts` | Step 2 |
| 10 | Test: happy-path — `searchFlights` called with correct `{origin, destination, date, adults}` including adults default of 1 | `src/cli.test.ts` | Step 2 |
| 11 | Test: `searchFlights` rejection → stderr contains error message, exit 1, stdout empty | `src/cli.test.ts` | Step 2 |
| 12 | Test: empty result array → stdout exactly `No flights found.`, exit 0 | `src/cli.test.ts` | Step 2 |
| 13 | Test: multi-row table via CLI — header row with ` | ` delimiter, separator row with ` | ` delimiter and N hyphens per column, Price right-aligned, data rows with ` | ` delimiter | `src/cli.test.ts` | Step 2 |
| 14 | Test: `renderTable` wiring — cli.ts calls `renderTable` and prints result to stdout | `src/cli.test.ts` | Step 2 |
| 15 | Create `src/table.test.ts` — import `renderTable` from `./table`, test as pure function (no process mocking needed) | `src/table.test.ts` | — |
| 16 | Test: multi-row table layout — separator present, segment lengths match column widths, Price right-aligned, ` | ` delimiter | `src/table.test.ts` | Step 15 |
| 17 | Test: single-row table output | `src/table.test.ts` | Step 15 |
| 18 | Test: empty array → returns exactly `No flights found.` | `src/table.test.ts` | Step 15 |
| 19 | Test: currency fallback to `£` when currency arg absent or empty string | `src/table.test.ts` | Step 15 |
| 20 | Test: header column order and padding — `Airline | Price | Departure | Arrival | Duration | Stops` with ` | ` delimiter | `src/table.test.ts` | Step 15 |
| 21 | Test: column width = max(header.length, longestDataValue.length) | `src/table.test.ts` | Step 15 |
| 22 | Test: non-Price columns left-aligned (trailing spaces), Price right-aligned (leading spaces after currency symbol) | `src/table.test.ts` | Step 15 |
| 23 | Test: `renderTable` function signature — `renderTable(flights: Flight[], currency?: string): string` | `src/table.test.ts` | Step 15 |
| 24 | Verify `tsc --noEmit` exits 0 (type correctness of test files) | project root | Steps 1-23 |
| 25 | Verify `vitest run` exits 0 with all tests green | project root | Steps 1-23 |
| 26 | Verify no new runtime dependencies added beyond SKY-001/SKY-002 | `package.json` | Step 25 |

---

## 2. Dependency Validation

| Dependency | Satisfied? | Reason |
|------------|-----------|--------|
| SKY-001 (project scaffold) | **Yes** | `package.json`, `tsconfig.json`, `vitest.config.ts`, `node_modules/` all exist at `/home/bradleyjerome/projects/skyscanner-app/`. `tsc --noEmit` passes. `vitest run` passes (19 tests in client.test.ts). |
| SKY-002 (SkyscannerClient) | **Yes** | `src/skyscanner/client.ts` exports `SkyscannerClient`, `SearchParams`, `FlightResult`. 19 tests passing. Constructor accepts `{ apiKey }`. `searchFlights(params: SearchParams): Promise<FlightResult[]>`. |
| SKY-003-impl (cli.ts) | **⚠️ Partially — has critical defects** | `src/cli.ts` exists and compiles, BUT has 6 defects vs ACs (see Risk #1). `src/table.ts` does NOT exist — `renderTable` is an inline void function in cli.ts instead of a separate module returning string. |
| Vitest + TypeScript toolchain | **Yes** | vitest 2.1.9, typescript 5.6.3 installed. `vitest.config.ts` configured with `globals: true`, `include: ['src/**/*.test.ts']`. |
| `src/table.ts` (SKY-003b) | **No — missing** | `src/table.ts` does not exist. `renderTable` is defined inline in `cli.ts` as a void function. ACs require a separate `src/table.ts` exporting `renderTable(flights: Flight[], currency?: string): string`. **Must escalate to impl story.** |

---

## 3. Risk Register

| # | Risk | Severity | Likelihood | Mitigation |
|---|------|----------|------------|------------|
| 1 | **cli.ts has 6 critical defects vs ACs** — (a) No `--date` format validation (AC-4 requires `^\d{4}-\d{2}-\d{2}$` check); (b) No `src/table.ts` — renderTable is inline void function (AC requires separate module returning string); (c) Wrong delimiter — uses `'  '` (two spaces) instead of `' | '` (space-pipe-space) for header, separator, and data rows; (d) `renderTable` returns void instead of string; (e) Currency handling uses code→symbol mapping instead of using API currency symbol with `£` fallback; (f) RAPIDAPI_KEY error message missing `Error: ` prefix (AC requires exact `Error: RAPIDAPI_KEY environment variable is required`). | 🔴 Critical | Certain | **Escalate all 6 defects to SKY-003-impl story** via `escalate_defect_to_sibling_story`. Write tests against the AC-specified behavior (correct behavior). Tests will fail until impl is fixed. Do NOT write tests that match broken implementation. |
| 2 | **`process.exit` interception may not work with async `main()`** — `cli.ts` exports `async function main()` that calls `process.exit()` after `await`. The `ProcessExitError` thrown by the mock must propagate through the async call chain. If `main()` catches the error internally (it has a try/catch), the `ProcessExitError` will be swallowed. | 🟡 Medium | High | Inspect cli.ts: the try/catch in `main()` catches all errors and calls `process.exit(1)`. The `ProcessExitError` from the `process.exit` mock will be caught by this try/catch, causing a second `process.exit(1)` call. **Solution:** Make `ProcessExitError` extend `Error` and add a check in the test: if the caught error is a `ProcessExitError`, assert its exit code; if it's a different error, the test should fail. Alternatively, mock `process.exit` to set a flag and throw, then check both the thrown error and the flag. |
| 3 | **Mock boundary path mismatch** — `cli.ts` imports `SkyscannerClient` from `'./skyscanner/client'`. The `vi.mock()` call must use the exact same relative path from the test file's perspective. If the test file is at `src/cli.test.ts`, the mock path should be `'./skyscanner/client'`. A path mismatch causes the mock to silently not apply, and real API calls will be attempted. | 🟡 Medium | Medium | Use `vi.mock('./skyscanner/client')` in `cli.test.ts` (same relative path as cli.ts uses). Verify mock is applied by checking `SkyscannerClient` constructor is a `vi.fn()` in a smoke test. For `table.test.ts`, no mock is needed — `renderTable` is a pure function. |

---

## 4. Test Plan

### New Tests Required

**File: `src/cli.test.ts`** (minimum 12 tests, covering SKY-003 AC-13's 9 required + 3 additional for completeness)

| Test # | Name | What It Verifies | AC Mapping |
|--------|------|-------------------|------------|
| 1 | missing --from flag | exit 2, stderr contains "--from", stdout empty | SKY-003 AC-3, SKY-003a AC-3 |
| 2 | missing --to flag | exit 2, stderr contains "--to", stdout empty | SKY-003 AC-3, SKY-003a AC-3 |
| 3 | missing --date flag | exit 2, stderr contains "--date", stdout empty | SKY-003 AC-3, SKY-003a AC-3 |
| 4 | invalid --date format | exit 2, stderr message, stdout empty, no network call | SKY-003 AC-4, SKY-003a AC-4 |
| 5 | invalid --adults value | exit 2 for non-integer/≤0/non-numeric, stderr message, stdout empty | SKY-003 AC-5, SKY-003a AC-5 |
| 6 | missing RAPIDAPI_KEY env var | exit 1, stderr contains "RAPIDAPI_KEY", stdout empty, no network call | SKY-003 AC-7, SKY-003a AC-7 |
| 7 | flag order independence | same searchFlights args regardless of flag order | SKY-003a AC-2 |
| 8 | happy-path searchFlights call | searchFlights called with correct {origin, destination, date, adults} | SKY-003 AC-5/6, SKY-003a AC-6/8 |
| 9 | searchFlights rejection → stderr + exit 1 | error message on stderr, exit 1, stdout empty | SKY-003 AC-12, SKY-003b AC-10 |
| 10 | empty result → "No flights found." + exit 0 | stdout exactly "No flights found.", exit 0 | SKY-003 AC-11, SKY-003b AC-8 |
| 11 | multi-row table output via CLI | stdout has header, separator, data rows with ` | ` delimiter, correct alignment | SKY-003 AC-8/9/10, SKY-003b AC-9 |
| 12 | renderTable wiring in cli.ts | cli.ts calls renderTable and prints result to stdout | SKY-003b AC-9 |

**File: `src/table.test.ts`** (minimum 8 tests per SKY-003b AC-11)

| Test # | Name | What It Verifies | AC Mapping |
|--------|------|-------------------|------------|
| 1 | multi-row table layout | separator present, segment lengths match column widths, Price right-aligned, ` | ` delimiter | SKY-003b AC-2/3/4/5/6 |
| 2 | single-row table | correct output for single flight | SKY-003b AC-11 |
| 3 | empty array | returns exactly "No flights found." | SKY-003b AC-8 |
| 4 | currency fallback | £ used when currency arg absent or empty | SKY-003b AC-7 |
| 5 | column width computation | width = max(header.length, longestDataValue.length) | SKY-003b AC-3 |
| 6 | header column order and padding | fixed order Airline|Price|Departure|Arrival|Duration|Stops with ` | ` delimiter | SKY-003b AC-2 |
| 7 | left-alignment non-Price, right-alignment Price | trailing spaces for non-Price, leading spaces for Price after currency | SKY-003b AC-5/6 |
| 8 | function signature | renderTable(flights: Flight[], currency?: string): string | SKY-003b AC-1 |

### Regression Scope
- **SKY-002 tests**: Run full `vitest run` to ensure no regressions in `src/skyscanner/client.test.ts` (19 existing tests)
- **SKY-001 scaffold**: Verify `tsc --noEmit` still passes after test files are added (note: tsconfig excludes `src/**/*.test.ts` so test files won't affect tsc)
- **No new dependencies**: Confirm `package.json` unchanged (no new deps added by test story)

### Test Infrastructure
- **Mock strategy for cli.test.ts:**
  - `vi.mock('./skyscanner/client')` with factory returning `{ SkyscannerClient: vi.fn() }`
  - Mock `SkyscannerClient` constructor to return object with `searchFlights: vi.fn()`
  - `vi.spyOn(process, 'exit').mockImplementation((code) => { throw new ProcessExitError(code) })`
  - `vi.spyOn(process.stdout, 'write').mockImplementation(() => true)` to capture stdout
  - `vi.spyOn(process.stderr, 'write').mockImplementation(() => true)` to capture stderr
  - `vi.stubEnv('RAPIDAPI_KEY', 'test-key')` / `delete process.env.RAPIDAPI_KEY` for env tests
  - Save/restore `process.argv` in beforeEach/afterEach
- **Mock strategy for table.test.ts:**
  - No mocks needed — `renderTable` is a pure function
  - Import `renderTable` from `./table` and `FlightResult` type from `./skyscanner/client`
  - Construct `FlightResult[]` fixtures directly

---

## 5. Acceptance Criteria Mapping

### SKY-003 Parent (15 ACs)

| AC # | Criterion | Implementation Step | Test File |
|------|-----------|---------------------|-----------|
| 1 | `src/cli.ts` exists, tsc --noEmit 0 errors | Step 24 | (build verification) |
| 2 | tsconfig outDir=dist, node dist/cli.js works | Step 24 | (build verification) |
| 3 | Missing --from/--to/--date → exit 2, stderr hint, stdout empty | Steps 3-5 | cli.test.ts |
| 4 | Invalid --date format → exit 2, stderr, stdout empty | Step 6 | cli.test.ts |
| 5 | Invalid --adults → exit 2, stderr, stdout empty | Step 7 | cli.test.ts |
| 6 | adults forwarded to searchFlights | Step 10 | cli.test.ts |
| 7 | Missing RAPIDAPI_KEY → exit 1, stderr "RAPIDAPI_KEY", stdout empty | Step 8 | cli.test.ts |
| 8 | Multi-row table: header, separator, data rows with ` | ` padding | Steps 13, 16, 20 | cli.test.ts + table.test.ts |
| 9 | Non-Price left-aligned, Price right-aligned | Step 22 | table.test.ts |
| 10 | Currency symbol from API, fallback £ | Step 19 | table.test.ts |
| 11 | Empty result → "No flights found.", exit 0 | Steps 12, 18 | cli.test.ts + table.test.ts |
| 12 | searchFlights rejects → stderr, exit 1, stdout empty | Step 11 | cli.test.ts |
| 13 | cli.test.ts has ≥9 passing vitest tests | Steps 3-14 | cli.test.ts |
| 14 | vitest run exits 0 | Step 25 | (runner verification) |
| 15 | No new runtime deps | Step 26 | package.json check |

### SKY-003a (10 ACs)

| AC # | Criterion | Implementation Step | Test File |
|------|-----------|---------------------|-----------|
| 1 | src/cli.ts exists, tsc --noEmit 0 | Step 24 | (build verification) |
| 2 | Flag order independence | Step 9 | cli.test.ts |
| 3 | Missing --from/--to/--date → exit 2, stderr, stdout empty | Steps 3-5 | cli.test.ts |
| 4 | Invalid --date → exit 2, stderr, stdout empty | Step 6 | cli.test.ts |
| 5 | Invalid --adults → exit 2, stderr, stdout empty | Step 7 | cli.test.ts |
| 6 | adults forwarded to searchFlights | Step 10 | cli.test.ts |
| 7 | RAPIDAPI_KEY missing → exact error string, exit 1 | Step 8 | cli.test.ts |
| 8 | renderTable called with searchFlights result | Step 14 | cli.test.ts |
| 9 | Network errors out of scope | (no test needed) | — |
| 10 | All cli.test.ts tests pass | Step 25 | (runner verification) |

### SKY-003b (11 ACs)

| AC # | Criterion | Implementation Step | Test File |
|------|-----------|---------------------|-----------|
| 1 | renderTable signature | Step 23 | table.test.ts |
| 2 | Header row fixed order, pipe-delimited, padded | Step 20 | table.test.ts |
| 3 | Column width = max(header, longestData) | Step 21 | table.test.ts |
| 4 | Separator row: N hyphens per column, ` | ` delimiter | Step 16 | table.test.ts |
| 5 | Non-Price left-aligned | Step 22 | table.test.ts |
| 6 | Price right-aligned | Step 22 | table.test.ts |
| 7 | Currency symbol, fallback £ | Step 19 | table.test.ts |
| 8 | Empty array → "No flights found." | Step 18 | table.test.ts |
| 9 | cli.ts calls renderTable, prints to stdout | Step 14 | cli.test.ts |
| 10 | searchFlights rejects → stderr, exit 1 | Step 11 | cli.test.ts |
| 11 | All table.test.ts tests pass | Step 25 | (runner verification) |

---

## 6. Cost/Effort Forecast

| Item | Estimated Hours | Notes |
|------|----------------|-------|
| Test harness setup (mocking, process.exit interception) | 1.5 | ProcessExitError class, vi.spyOn setup, env var management |
| cli.test.ts — 12 tests | 3.0 | Arg validation (5), env var (1), flag order (1), happy-path (1), rejection (1), empty result (1), table via CLI (1), wiring (1) |
| table.test.ts — 8 tests | 2.0 | Pure function tests, simpler mocking |
| Defect escalation coordination | 1.0 | 6 defects in cli.ts need escalation to impl story; may need iteration |
| Debugging / mock boundary issues | 1.0 | Risk #2 (process.exit in async), Risk #3 (mock path) |
| Build verification + regression | 0.5 | tsc --noEmit, vitest run, package.json check |
| **Total** | **9.0** | **Original estimate: 15h (combined impl+test). Test-only: 9h.** |

The parent story SKY-003 estimated 15 hours for combined implementation + testing. Since this is the test-only story and implementation has critical defects requiring escalation, the test effort is estimated at **9 hours** — higher than a clean test-only story due to the defect escalation overhead. **Recommend adjusting estimatedHours from 15 to 9** for this test-only story.

---

## Key Decisions
1. **Two test files**: `cli.test.ts` for CLI behavior (arg parsing, env vars, exit codes, wiring) and `table.test.ts` for pure rendering logic. This matches the SKY-003a/SKY-003b split.
2. **Tests written against AC-specified behavior**, not current broken implementation. Tests will fail until impl defects are fixed.
3. **Defect escalation required**: 6 critical defects in `cli.ts` must be escalated to the impl story before tests can pass. The test story writes tests first; impl fixes are coordinated via `escalate_defect_to_sibling_story`.
4. **Mock strategy**: `vi.mock()` at module boundary for `SkyscannerClient`; `vi.spyOn` for `process.exit`, `process.stdout.write`, `process.stderr.write`; `vi.stubEnv` for env vars.
5. **Scope leak handling**: AC-9 and AC-10 from SKY-003b (CLI wiring and error rejection) are tested in `cli.test.ts`, not `table.test.ts`, since `table.ts` is a pure function with no access to stderr/process.exit.
