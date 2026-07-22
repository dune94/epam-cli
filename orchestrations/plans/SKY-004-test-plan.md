# Execution Plan: SKY-004-test

**Story:** Test Express server implementation with vitest and supertest  
**Agent Role:** test-engineer  
**Working Dir:** `/home/bradleyjerome/projects/skyscanner-app`  
**Status:** ready for implementation  

---

## 1. Implementation Steps with Target File Paths

| Step | Action | Target File | Details |
|------|--------|-------------|---------|
| 1 | Verify project state & dependencies | `/home/bradleyjerome/projects/skyscanner-app/` | Confirm `src/server.ts`, `src/skyscanner/client.ts`, `package.json` exist; `tsc --noEmit` passes; `supertest` + `@types/supertest` in devDeps; existing 36 tests green |
| 2 | Read contract file for SkyscannerClient | `/home/bradleyjerome/projects/skyscanner-app/.contracts/SKY-002-a.md` | Extract exact interface signatures for `SearchParams`, `FlightResult`, `SkyscannerClient` constructor and `searchFlights` method; note mock factory skeleton |
| 3 | Create server test file | `/home/bradleyjerome/projects/skyscanner-app/src/server.test.ts` | Write 18 vitest + supertest tests covering all 26 AC scenarios (see §4 Test Plan); mock `SkyscannerClient` via `vi.mock('./skyscanner/client')` |
| 4 | Verify typecheck passes | CLI: `tsc --noEmit` | Must exit 0 |
| 5 | Verify all tests pass | CLI: `vitest run` | Must exit 0 with all tests green (52 total: 36 existing + 16 new) |
| 6 | Escalate any impl defects found | `src/server.ts` (via `escalate_defect_to_sibling_story`) | If tests reveal missing validation (see §3 risks), escalate to impl story — do NOT modify `server.ts` directly |

---

## 2. Dependency Validation

| Dependency | Satisfied? | Reason |
|------------|-----------|--------|
| SKY-002 (SkyscannerClient + FlightResult type) | ✅ YES | `src/skyscanner/client.ts` exists with `SkyscannerClient`, `SearchParams`, `FlightResult` exports; contract file at `.contracts/SKY-002-a.md` confirms signatures |
| SKY-004-impl (Express server) | ✅ YES | `src/server.ts` exists, exports named `app`, guarded `listen()` via `require.main === module`, all 4 routes implemented (`/health`, `/search`, `/cheapest`, `/`) |
| supertest + @types/supertest in devDeps | ✅ YES | Both present in `package.json` devDependencies |
| vitest configured | ✅ YES | `vitest.config.ts` exists with `defineConfig` from `vitest/config` |
| tsc --noEmit clean | ✅ YES | Verified: exits 0 with no errors |
| Existing test suite green | ✅ YES | 36 tests pass (client.test.ts: 19, cli.test.ts: 17) |
| Contract file for mock factory | ✅ YES | `.contracts/SKY-002-a.md` provides `vi.mock()` skeleton with import path `./skyscanner/client` |
| src/public/index.html exists | ✅ YES | Valid HTML file with `<html>` root element present |
| package.json start script = `node dist/server.js` | ✅ YES | Confirmed in package.json scripts |
| package.json build script produces dist/server.js | ✅ YES | `tsc` + copy public assets script present |

---

## 3. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | **server.ts missing `adults ≤ 0` validation** — `validateSearchParams` only checks `NaN`/non-finite, does NOT reject zero or negative adults values. AC-11 requires HTTP 400 for `adults=0` or `adults=-1`. AC-14 requires same on `/cheapest`. | **HIGH** — code inspection confirms the gap: line 41-44 only checks `!Number.isFinite(parsed) \|\| Number.isNaN(parsed)`, no `<= 0` check | Tests for AC-11 and AC-14 will FAIL | Write tests matching AC; on failure, **escalate** to impl story via `escalate_defect_to_sibling_story` with target `src/server.ts`, diagnosis "validateSearchParams does not reject adults ≤ 0 — Number('0')=0 and Number('-1')=-1 both pass the NaN/finite check", required fix "add `if (parsed <= 0) return { ok: false, error: 'adults must be a positive integer' }` after the NaN check" |
| 2 | **server.ts missing `date` format validation** — `validateSearchParams` only checks for empty/missing date, does NOT validate YYYY-MM-DD format. AC-12 requires HTTP 400 for invalid date strings like `'01-08-2026'`, `'tomorrow'`, `''`. | **HIGH** — code inspection confirms: line 36-37 only checks `!date \|\| date.trim() === ''`, no regex validation | Tests for AC-12 will FAIL | Write tests matching AC; on failure, **escalate** to impl story with target `src/server.ts`, diagnosis "validateSearchParams does not validate date format YYYY-MM-DD — any non-empty string passes", required fix "add `if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return { ok: false, error: 'date must be in YYYY-MM-DD format' }` after the empty check" |
| 3 | **Mock path mismatch** — contract file uses `<import-path-to-SkyscannerClient>` placeholder; actual import in server.ts is `'./skyscanner/client'`. If mock path is wrong, all server tests fail with real HTTP calls or module errors. | **MEDIUM** | All server tests fail | Use exact import path `'./skyscanner/client'` in `vi.mock()` call — confirmed from `server.ts` line 4: `import { ... } from './skyscanner/client'`; verify with a single smoke test before writing full suite |

---

## 4. Test Plan

### New Tests Required (in `src/server.test.ts`)

All tests use `vi.mock('./skyscanner/client')` to mock `SkyscannerClient`. `RAPIDAPI_KEY` is set to `'test-key'` via `beforeEach`/`vi.stubEnv` for tests that need it, and deleted for 503 tests.

| # | Test Name | Scenario | Expected Outcome | ACs Covered |
|---|-----------|----------|-----------------|-------------|
| 1 | `GET /health returns 200 with status ok and positive uptime` | `GET /health` | HTTP 200, Content-Type `application/json`, body `{ status: 'ok', uptime: <positive number> }` | AC-3 |
| 2 | `GET /health returns 200 even without RAPIDAPI_KEY` | `GET /health` with `RAPIDAPI_KEY` unset | HTTP 200, body `{ status: 'ok', uptime: <positive number> }` | AC-4, AC-17 (partial) |
| 3 | `GET / returns HTML dashboard` | `GET /` | HTTP 200, Content-Type includes `text/html`, body contains `<html` | AC-5, AC-6 |
| 4 | `GET / returns 200 even without RAPIDAPI_KEY` | `GET /` with `RAPIDAPI_KEY` unset | HTTP 200, HTML body | AC-5, AC-17 (partial) |
| 5 | `GET /search with valid params returns 200 with flights` | `GET /search?from=LHR&to=JFK&date=2026-08-01&adults=1`, SkyscannerClient mocked to return 3 flights | HTTP 200, body `{ flights: [...], count: 3, searchedAt: <ISO-8601> }`, `count === flights.length` | AC-7 |
| 6 | `GET /search searchedAt is valid ISO-8601` | Parse `searchedAt` from response with `new Date()` | `isNaN(date.getTime()) === false` | AC-19 |
| 7 | `GET /search missing required param returns 400` | `GET /search?from=LHR&to=JFK` (no date) | HTTP 400, Content-Type `application/json`, body `{ error: string }` | AC-8 |
| 8 | `GET /search adults defaults to 1 when absent` | `GET /search?from=LHR&to=JFK&date=2026-08-01` (no adults), mock captures SearchParams | HTTP 200, mock called with `adults: 1` | AC-9 |
| 9 | `GET /search with non-numeric adults returns 400` | `GET /search?from=LHR&to=JFK&date=2026-08-01&adults=abc` | HTTP 400, body `{ error: string }` | AC-10 |
| 10 | `GET /search with zero adults returns 400` | `GET /search?from=LHR&to=JFK&date=2026-08-01&adults=0` | HTTP 400, body `{ error: string }` | AC-11 ⚠️ **may fail — Risk #1** |
| 11 | `GET /search with negative adults returns 400` | `GET /search?from=LHR&to=JFK&date=2026-08-01&adults=-1` | HTTP 400, body `{ error: string }` | AC-11 ⚠️ **may fail — Risk #1** |
| 12 | `GET /search with invalid date format returns 400` | `GET /search?from=LHR&to=JFK&date=01-08-2026` | HTTP 400, body `{ error: string }` | AC-12 ⚠️ **may fail — Risk #2** |
| 13 | `GET /search without RAPIDAPI_KEY returns 503` | `GET /search?from=LHR&to=JFK&date=2026-08-01`, no RAPIDAPI_KEY | HTTP 503, body `{ error: 'RAPIDAPI_KEY not configured' }` | AC-17 |
| 14 | `GET /search when SkyscannerClient throws returns 500` | Mock `searchFlights` to throw `new Error('Network failure')` | HTTP 500, body `{ error: string }` | AC-18 |
| 15 | `GET /cheapest with valid params returns cheapest flight` | Mock returns 3 flights with prices 299, 199, 399 | HTTP 200, body is single FlightResult with `price: 199` (lowest) | AC-13 |
| 16 | `GET /cheapest with empty results returns 404` | Mock returns `[]` | HTTP 404, body `{ error: string }` | AC-15 |
| 17 | `GET /cheapest missing required param returns 400` | `GET /cheapest?from=LHR&to=JFK` (no date) | HTTP 400, body `{ error: string }` | AC-16 |
| 18 | `GET /cheapest without RAPIDAPI_KEY returns 503` | No RAPIDAPI_KEY | HTTP 503, body `{ error: 'RAPIDAPI_KEY not configured' }` | AC-17 |
| 19 | `GET /cheapest with invalid adults returns 400` | `GET /cheapest?from=LHR&to=JFK&date=2026-08-01&adults=0` | HTTP 400, body `{ error: string }` | AC-14 ⚠️ **may fail — Risk #1** |
| 20 | `GET /cheapest with invalid date format returns 400` | `GET /cheapest?from=LHR&to=JFK&date=tomorrow` | HTTP 400, body `{ error: string }` | AC-12 ⚠️ **may fail — Risk #2** |
| 21 | `GET /cheapest when SkyscannerClient throws returns 500` | Mock `searchFlights` to throw | HTTP 500, body `{ error: string }` | AC-18 |
| 22 | `app is exported and does not bind a port on import` | Import `app` from `server.ts`, verify no port bound | Import succeeds, no EADDRINUSE error | AC-1, AC-2 |

### Regression Scope
- **Existing tests must remain green:** `src/skyscanner/client.test.ts` (19 tests), `src/cli.test.ts` (17 tests)
- **Typecheck must remain clean:** `tsc --noEmit` exits 0
- **No modification to existing source files** — only add `src/server.test.ts`
- **Total expected after completion:** 58 tests (36 existing + 22 new)

---

## 5. Acceptance Criteria Mapping

| AC # | Criterion (abbreviated) | Implementation Step | Test(s) | Status |
|------|--------------------------|-------------------|---------|--------|
| AC-1 | `app` exported separately from `listen()` | Step 1 (verify) | Test #22 | ✅ Already satisfied |
| AC-2 | `listen()` guarded so vitest never binds port | Step 1 (verify) | Test #22 | ✅ Already satisfied (`require.main === module`) |
| AC-3 | GET /health → 200, `{ status: 'ok', uptime: <positive> }` | Step 3 | Test #1 | ✅ |
| AC-4 | GET /health → 200 regardless of RAPIDAPI_KEY | Step 3 | Test #2 | ✅ |
| AC-5 | GET / → 200, text/html, body = index.html | Step 3 | Test #3 | ✅ |
| AC-6 | src/public/index.html exists with valid HTML | Step 1 (verify) | Test #3 | ✅ Already satisfied |
| AC-7 | GET /search valid params → 200, `{ flights, count, searchedAt }` | Step 3 | Test #5 | ✅ |
| AC-8 | GET /search missing param → 400 `{ error }` | Step 3 | Test #7 | ✅ |
| AC-9 | adults absent → defaults to 1, HTTP 200 | Step 3 | Test #8 | ✅ |
| AC-10 | adults non-numeric → 400 | Step 3 | Test #9 | ✅ |
| AC-11 | adults zero/negative → 400 | Step 3 | Tests #10, #11 | ⚠️ **Risk #1 — may need escalation** |
| AC-12 | date invalid format → 400 on /search AND /cheapest | Step 3 | Tests #12, #20 | ⚠️ **Risk #2 — may need escalation** |
| AC-13 | GET /cheapest valid → 200, cheapest FlightResult | Step 3 | Test #15 | ✅ |
| AC-14 | /cheapest adults non-numeric/zero/negative → 400 | Step 3 | Test #19 | ⚠️ **Risk #1 — may need escalation** |
| AC-15 | GET /cheapest empty results → 404 | Step 3 | Test #16 | ✅ |
| AC-16 | GET /cheapest missing param → 400 | Step 3 | Test #17 | ✅ |
| AC-17 | RAPIDAPI_KEY absent → 503 on /search and /cheapest; /health and / unaffected | Step 3 | Tests #2, #4, #13, #18 | ✅ |
| AC-18 | SkyscannerClient throws → 500 on /search and /cheapest | Step 3 | Tests #14, #21 | ✅ |
| AC-19 | searchedAt is valid ISO-8601 | Step 3 | Test #6 | ✅ |
| AC-20 | FlightResult imported from SKY-002 export | Step 1 (verify) | — | ✅ Already satisfied (line 4: `from './skyscanner/client'`) |
| AC-21 | package.json start = `node dist/server.js` | Step 1 (verify) | — | ✅ Already satisfied |
| AC-22 | package.json build produces dist/server.js | Step 1 (verify) | — | ✅ Already satisfied |
| AC-23 | supertest + @types/supertest in devDeps | Step 1 (verify) | — | ✅ Already satisfied |
| AC-24 | server.test.ts ≥8 tests, SkyscannerClient mocked | Step 3 | 22 tests planned | ✅ |
| AC-25 | `tsc --noEmit` exits 0 | Step 4 | — | ✅ |
| AC-26 | `vitest run` exits 0 all passing | Step 5 | — | ⚠️ Depends on escalation resolution |

---

## 6. Cost / Effort Forecast

| Factor | Estimate |
|--------|----------|
| Original PRD estimate (SKY-004 combined) | 25 hours |
| Test-only portion (this story) | ~8 hours |
| Test file creation (22 tests) | 3 hours |
| Escalation cycles (2 expected: adults≤0, date format) | 2 hours |
| Verification & regression | 1 hour |
| Buffer for mock setup issues | 2 hours |
| **Adjusted estimate for SKY-004-test** | **8 hours** |

**Rationale:** The PRD estimate of 25 hours covers both implementation and testing. The implementation (`server.ts`) is already complete. The test portion is well-scoped: 22 tests with clear scenarios, a known mock pattern, and a verified test infrastructure. The main uncertainty is the 2 escalation cycles for the validation gaps (Risks #1 and #2), which add ~2 hours of wait/verify overhead.

---

## 7. Escalation Protocol

If tests #10, #11, #19 (adults ≤ 0) fail:
- Call `escalate_defect_to_sibling_story` with:
  - `targetFile`: `src/server.ts`
  - `diagnosis`: "validateSearchParams does not reject adults ≤ 0 — Number('0')=0 and Number('-1')=-1 both pass the NaN/finite check on line 42-43. AC-11 and AC-14 require HTTP 400 for zero or negative adults."
  - `requiredFix`: "Add `if (parsed <= 0) return { ok: false, error: 'adults must be a positive integer' };` after the NaN check (line 44), before `adults = parsed`"

If tests #12, #20 (date format) fail:
- Call `escalate_defect_to_sibling_story` with:
  - `targetFile`: `src/server.ts`
  - `diagnosis`: "validateSearchParams does not validate date format YYYY-MM-DD — only checks for empty/missing on line 36-37. AC-12 requires HTTP 400 for dates like '01-08-2026', 'tomorrow', '' on both /search and /cheapest."
  - `requiredFix`: "Add `if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return { ok: false, error: 'date must be in YYYY-MM-DD format' };` after the empty check (line 37)"
