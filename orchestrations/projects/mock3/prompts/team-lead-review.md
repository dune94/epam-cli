__REVIEW_PROFILE__

---
REVIEW TASK: Story __STORY_ID__ — __STORY_TITLE__

DESCRIPTION:
__STORY_DESC__

ACCEPTANCE CRITERIA:
__STORY_ACS__
__VC_BLOCK__
__UNCOVERED_VC_BLOCK__
__FIX_ANALYSIS_BLOCK__
__BLOCKER_DISCIPLINE__

RELEVANT FILES (fix files + the reproducing test the pipeline shipped — review BOTH): __STORY_FILES__ __TEST_FILES__

GIT DIFF (recent changes):
```diff
__STORY_DIFF__
```

PROJECT ROOT: __PROJECT_ROOT__
__CODEGRAPH_TOOL_BLOCK__

PROJECT CONTEXT — mock3 is a two-codeline TypeScript workspace. Both codelines
(mocka and mockb) share identical tooling and layout:

- Layout: source in `src/`, tests in `test/`. Tests import from `../src/<module>`.
- Module system: ESM (`"type": "module"`, `module: "ES2022"`,
  `moduleResolution: "bundler"`). Imports use `import/export` syntax.
- TypeScript: `strict: true`, `target: "ES2022"`, `noEmit: true`. The fix MUST
  compile under `tsc --noEmit` with zero errors.
- Test runner: vitest (`vitest run`). Tests use `describe`/`it`/`expect` from
  `vitest`. Run `npm test` to execute; run `npm run build` (= `tsc --noEmit`)
  to type-check.
- No linter is configured (`lint` script echoes a placeholder). Do NOT flag
  lint-style issues.

Both tickets in this project are boundary/off-by-one defects:
- MOCK3-1 (mocka, `src/fares.ts`): `fareFor` checks `rider.age > 65` instead of
  `>= 65`. The correct fix is changing `>` to `>=` on that single line. Any fix
  that adds new branches, new constants, or restructures the function is
  over-engineered — request changes.
- MOCK3-2 (mockb, `src/schedule.ts`): `formatStops` loops `i < stops.length - 1`
  instead of `i < stops.length`. The correct fix is removing the `- 1`. Any fix
  that rewrites the loop, adds a separate append for the last element, or
  introduces a new helper is over-engineered — request changes.

When reviewing, confirm the fix is the minimal change that corrects the
boundary without altering behaviour for other age groups (MOCK3-1) or other
stop counts (MOCK3-2).

CREDENTIALS. Call scan_secrets with the diff above before you finish. It reports values that
have been PASTED INTO the code — a quoted, long, high-entropy literal assigned to a
credential-shaped name. It deliberately does NOT report references (an identifier, a member
expression, a process.env read), because those are the correct practice: a pasted key is always
a literal, so nothing real is missed by ignoring them.

  scan_secrets(diff="<the GIT DIFF above>")

Judge what it returns; it does not block anything. A finding is a blocker — a credential in
source is not fixable after the fact once committed. An empty result is not proof of safety on
its own, so if the diff introduces configuration you can still say so in your own words.

This check used to run at commit time and matched `name: value` on shape alone. On 2026-08-09
it refused a correct commit for `management_token: SOME_SERVICE_API_TOKEN` — an
environment-derived identifier — and had never caught a real leak. It is yours now because you
have the diff and can tell the two apart.

Review the implementation against each acceptance criterion above.
Check: TypeScript strict compliance, error handling, security (OWASP).
__TEST_OWNERSHIP__

CONCISION & REUSE (blocker-level checks):
- If the change addresses the symptom but NOT the prescribed root cause above (e.g. adds new code paths the bug never reaches), that is a 'blocker' — request changes.
- If a MORE CONCISE change (fewer lines) would achieve the same acceptance criteria, request changes and name the smaller change. Fewer lines of code is always better.
- If the diff hand-rolls logic that an EXISTING function/helper already provides (verify with the tool above), that is a 'blocker' — request changes and name the helper to reuse instead.
- Do NOT approve an over-engineered fix just because it satisfies the AC wording.

TEST COVERAGE VERIFICATION (grounded, not a visual skim — found live 2026-08-03,
Observed live: the reviewer claimed 2 of 3 required test scenarios were missing,
TWICE in a row, against a diff that unambiguously contained all 3 as clearly-
named `it(...)` blocks — a real, reproducible failure to verify a claim the
tools below could have confirmed in one call):
- Before flagging ANY acceptance-criteria test scenario as missing or absent, use
  the search tool to grep the diff above (or read_file on the test file under
  PROJECT_ROOT) for an `it(`/`test(` block whose name or body plausibly covers
  that scenario. A large diff is easy to skim past a matching block — search for
  it, do not judge from a visual read alone.
- If your search finds a plausible match, do NOT flag that scenario as missing —
  if the test's assertions are wrong or incomplete, say so specifically (quote
  the test name and what it fails to assert); 'missing' and 'inadequate' are
  different findings and must not be conflated.
- If your search finds nothing, name the exact search you ran (tool + query) in
  the issue description, so a genuinely absent test is distinguishable from an
  unverified guess.
Do NOT read from external URLs.
__LEARNED_RULES_BLOCK__
__PROJECT_TOOLS_BLOCK__

Respond with ONLY a JSON object (no markdown fences):
{"verdict":"approved","issues":[],"summary":"..."}
  OR
{"verdict":"changes_requested","issues":[{"severity":"blocker|major|minor","file":"...","line":0,"description":"...","suggestedFix":"..."}],"summary":"..."}

A 'blocker' issue MUST be fixed before merge. 'major' should be fixed. 'minor' is optional.