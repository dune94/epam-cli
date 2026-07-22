# Execution Plan — SKY-003-b: Flight Result Table Renderer

**Story ID:** SKY-003-b  
**Title:** Flight result table renderer with alignment, padding, and separator row  
**Agent Role:** typescript-engineer  
**Working Dir:** /tmp/skyscanner-app  
**Estimated Hours:** 15 (confirmed — see §6)

---

## 1. Implementation Steps with Target File Paths

| Step | Action | Target File | Details |
|------|--------|-------------|---------|
| 1 | Create `src/table.ts` — pure rendering module | `/tmp/skyscanner-app/src/table.ts` | Export `renderTable(flights: Flight[], currency?: string): string`. Import `Flight` type from `src/skyscanner/client.ts` (SKY-002). Implement column-width computation, header row, separator row, data rows with left-alignment (all cols) and right-alignment (Price col). Pipe delimiter ` | ` with one space padding each side. Currency symbol prepended to Price; fallback `£` when `currency` arg is absent/empty. Empty array → return `"No flights found."`. |
| 2 | Create `src/table.test.ts` — unit tests for renderTable | `/tmp/skyscanner-app/src/table.test.ts` | Vitest tests covering: (a) multi-row table — verify header order, separator segment lengths match column widths, Price right-alignment; (b) single-row table; (c) empty array returns `"No flights found."`; (d) currency fallback to `£` when arg omitted; (e) currency fallback to `£` when arg is empty string; (f) explicit currency symbol used when provided. No mocking needed — pure function. |
| 3 | Wire `renderTable` into `src/cli.ts` | `/tmp/skyscanner-app/src/cli.ts` (existing, from SKY-003a) | Import `renderTable` from `./table.js`. Replace any stub call with `renderTable(flights, flights[0]?.currency)` or pass currency from the first flight result. Print returned string to stdout via `console.log`. Add error-rejection handler: when `searchFlights` rejects, write error message to stderr and `process.exit(1)`. |
| 4 | Add integration-level tests to `src/cli.test.ts` | `/tmp/skyscanner-app/src/cli.test.ts` (existing, from SKY-003a) | Add tests for: (a) `searchFlights` rejection → stderr contains error message, exit code 1, stdout empty; (b) happy path → stdout contains renderTable output (verify header + separator + data row structure). These complement the existing SKY-003a validation tests. |
| 5 | Verify full suite passes | `/tmp/skyscanner-app/` (project root) | Run `tsc --noEmit` → exit 0. Run `vitest run` → all tests green. |

---

## 2. Dependency Validation

| Dependency | Status | Reason |
|------------|--------|--------|
| SKY-001 (Scaffold) | ⚠️ **Not completed** (status: pending) | Project directory `/tmp/skyscanner-app` does not exist yet. SKY-001 must be executed first to create the project skeleton, install deps, and establish tsconfig/vitest config. |
| SKY-002 (API Client) | ✅ Satisfied | Status: completed. Exports `SkyscannerClient`, `SearchParams`, `FlightResult` interfaces from `src/skyscanner/client.ts`. SKY-003b imports `FlightResult` (aliased as `Flight`) for the `renderTable` signature. |
| SKY-003a (CLI parsing) | ✅ Satisfied | Status: completed. `src/cli.ts` exists with flag parsing, env-var guard, and `SkyscannerClient` wiring. SKY-003b adds `renderTable` integration and error-rejection handling. |

**Blocking issue:** SKY-001 is not completed. The project directory `/tmp/skyscanner-app` does not exist. SKY-003b cannot proceed until SKY-001 creates the scaffold. If SKY-001 is being handled by another agent in parallel, SKY-003b must wait for the directory to appear.

---

## 3. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-------------|--------|------------|
| 1 | **SKY-001 scaffold missing** — `/tmp/skyscanner-app` does not exist; all file writes and tsc/vitest checks will fail | High | Critical | Block SKY-003-b start until SKY-001 completes. Add a pre-flight check: `test -d /tmp/skyscanner-app && test -f /tmp/skyscanner-app/package.json` before any implementation step. |
| 2 | **AC-10 scope leak** — "When searchFlights rejects, stderr + exit 1" is CLI process behavior, not table.ts behavior. The coordinator flagged this as a SCOPE_LEAK from the original SKY-003 split. | Medium | Medium | Implement AC-10 in `src/cli.ts` (Step 3) since that's where process.exit/stderr live. `src/table.ts` remains a pure function with no side effects. Document this decision clearly. |
| 3 | **Flight type import path mismatch** — SKY-002 exports `FlightResult` from `src/skyscanner/client.ts`, but SKY-003b AC-1 references `Flight[]`. If the import path or type name differs, tsc will fail. | Low | Medium | Verify the exact export name and path from SKY-002 before writing the import. Use `type Flight = FlightResult` alias if needed to match the AC signature. |

---

## 4. Test Plan

### New Tests Required

| Test File | Test Case | AC Covered |
|-----------|-----------|------------|
| `src/table.test.ts` | Multi-row table: header order, separator segment lengths match column widths, Price right-aligned | AC-2, AC-3, AC-4, AC-5, AC-6 |
| `src/table.test.ts` | Single-row table renders correctly | AC-11 (single-row) |
| `src/table.test.ts` | Empty array returns `"No flights found."` | AC-8 |
| `src/table.test.ts` | Currency fallback to `£` when arg omitted | AC-7 |
| `src/table.test.ts` | Currency fallback to `£` when arg is empty string | AC-7 |
| `src/table.test.ts` | Explicit currency symbol used when provided | AC-7 |
| `src/cli.test.ts` | searchFlights rejection → stderr has error message, exit 1, stdout empty | AC-10 |
| `src/cli.test.ts` | Happy path → stdout contains renderTable output with header/separator/data | AC-9 |

### Regression Scope

| Area | Concern | Verification |
|------|---------|--------------|
| SKY-003a CLI tests | Importing `renderTable` into `cli.ts` must not break existing flag-parsing, env-var, or validation tests | Run full `vitest run` — all existing SKY-003a tests must still pass |
| SKY-002 API client | No changes to `src/skyscanner/client.ts` | `tsc --noEmit` confirms no type regressions |
| Build | `tsc` must still compile cleanly after adding `src/table.ts` | `tsc --noEmit` exits 0 |

---

## 5. Acceptance Criteria Mapping

| AC | Criterion | Implementation Step |
|----|-----------|---------------------|
| AC-1 | `src/table.ts` exists, exports `renderTable(flights: Flight[], currency?: string): string`, tsc clean | Step 1 (create table.ts) |
| AC-2 | Header row in fixed pipe-delimited order with padding | Step 1 (renderTable header logic) |
| AC-3 | Column width = max(header.length, longestDataValue.length) | Step 1 (computeWidths function) |
| AC-4 | Separator row: N hyphens per column, pipe-delimited | Step 1 (renderSeparator function) |
| AC-5 | Non-Price columns left-aligned (trailing spaces) | Step 1 (padLeft function) |
| AC-6 | Price column right-aligned (leading spaces after currency) | Step 1 (padRight function) |
| AC-7 | Currency symbol from arg; fallback `£` when absent/empty | Step 1 (currency logic in renderTable) |
| AC-8 | `renderTable([])` returns `"No flights found."` | Step 1 (early return for empty array) |
| AC-9 | `cli.ts` calls `renderTable` and prints to stdout | Step 3 (wire renderTable into cli.ts) |
| AC-10 | searchFlights rejection → stderr + exit 1 | Step 3 (add catch handler in cli.ts) + Step 4 (test) |
| AC-11 | Vitest tests cover all specified scenarios | Step 2 (table.test.ts) + Step 4 (cli.test.ts additions) |

---

## 6. Cost / Effort Forecast

**Estimated hours: 15** — **Confirmed, no adjustment needed.**

Breakdown:
- Step 1 (table.ts): ~4h — column-width computation, alignment, separator, currency, edge cases
- Step 2 (table.test.ts): ~3h — 6 test cases with precise string assertions
- Step 3 (cli.ts wiring): ~2h — import, wire, add error handler
- Step 4 (cli.test.ts additions): ~2h — 2 integration-level tests with mocked client
- Step 5 (verification + debugging): ~2h — tsc, vitest, fix any alignment edge cases
- Buffer: ~2h — for SKY-001 dependency wait and potential rework

---

## Pre-flight Checklist (before starting implementation)

1. ✅ Verify `/tmp/skyscanner-app/` exists and `package.json` is present
2. ✅ Verify `src/skyscanner/client.ts` exports `FlightResult` (from SKY-002)
3. ✅ Verify `src/cli.ts` exists with flag parsing (from SKY-003a)
4. ✅ Verify `tsc --noEmit` passes on current codebase
5. ✅ Verify `vitest run` passes on current codebase
