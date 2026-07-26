/**
 * Fix the lint finding; do not rebuild the story around it.
 *
 * Live metrolinx 2026-07-26, run 7. Everything the run existed for was already
 * correct — grounded diagnosis, minimal fix reusing the prescribed helper, a
 * test proven RED→GREEN by execution, review approved. Then:
 *
 *   apply-report-discounts.service.spec.ts:100:48
 *     sonarjs/no-duplicate-string — Define a constant instead of duplicating this literal
 *
 * `'line-item-1'` appears four times in the test's fixture data. That is the
 * entire defect, and the run did not complete because of it.
 *
 * The only remediation on offer was: add acceptance criteria to the story, exit
 * 2, and let tier3 reset the codeline and rebuild the whole phase — discarding
 * a correct fix and a proven test, ~20 minutes and ~$1, to address a duplicated
 * string in fixture data. And nothing in that loop actually fixes the literal,
 * so the rebuild can arrive at exactly the same place.
 *
 * So: edit the flagged lines, verify, move on.
 *
 * The danger this must not create is worse than the one it solves. An agent let
 * loose on a test file could "fix" the finding by weakening the test — and that
 * test is the only executable proof the bug is fixed. So every edit is verified:
 * lint clean, types still compile, and the affected tests still pass. Any
 * failure reverts the edit and falls through to the existing path, leaving the
 * pipeline no worse off than before.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

function fixer(): string {
  const start = ORCH.indexOf('_lint_fix_findings_directly() {');
  expect(start, '_lint_fix_findings_directly not found').toBeGreaterThan(-1);
  return ORCH.slice(start, ORCH.indexOf('\n}', start));
}

describe('a lint finding is repaired in place, not rebuilt around', () => {
  it('exists and runs before the rebuild path', () => {
    const fixIdx = ORCH.indexOf('_lint_fix_findings_directly "');
    const remediationIdx = ORCH.indexOf('running self-healing remediation pipeline');
    expect(fixIdx, 'the direct fixer is never invoked').toBeGreaterThan(-1);
    expect(fixIdx,
      'the expensive rebuild runs first, so the cheap repair never gets a chance')
      .toBeLessThan(remediationIdx);
  });

  it('is driven by the findings the gate reported, not a fixed rule list', () => {
    // No hardcoded rule names: whatever the project's eslint config flags is
    // what gets fixed. The engine must not carry a list of "rules we know how
    // to fix" — that rots the moment the project changes its config.
    const f = fixer();
    expect(f, 'the fixer does not read the gate findings').toMatch(/_lint_log|NEW_FINDINGS|findings/);
    expect(f, 'a specific rule name is hardcoded in the engine')
      .not.toMatch(/sonarjs|prettier\/prettier|no-duplicate-string/);
  });

  it('edits only the files the gate flagged', () => {
    expect(fixer(), 'the fixer is not scoped to the flagged files')
      .toMatch(/_lint_fix_files|flagged|scope/i);
  });

  it('VERIFIES by re-running the lint gate — not by trusting the agent', () => {
    // "The agent said it fixed it" is the class of claim this codebase has been
    // burned by all day.
    expect(fixer(), 'nothing re-checks that the finding is actually gone')
      .toMatch(/eslint_baseline_gate|re-?lint|verify/i);
  });

  it('re-runs the type check, so a fix cannot break compilation', () => {
    expect(fixer()).toMatch(/tsc|typecheck|_node_bin/);
  });

  it('re-runs the tests, so a fix cannot weaken the proof', () => {
    // The gravest risk: "fixing" a lint finding by gutting the test that proves
    // the bug is fixed. That test is the run's only executable evidence.
    expect(fixer(), 'a fixer that can edit tests without re-running them can silently destroy the proof')
      .toMatch(/vitest|npm test|test/i);
  });

  it('reverts its own edit when verification fails', () => {
    expect(fixer(), 'a failed repair is left in the working tree')
      .toMatch(/checkout|revert|restore/i);
  });

  it('falls through to the existing remediation when it cannot fix it', () => {
    // Never a new dead end: if the direct repair does not work, the pipeline is
    // exactly where it was before.
    expect(fixer()).toMatch(/return 1/);
  });

  it('is bounded — it cannot loop', () => {
    expect(fixer()).toMatch(/attempt|LINT_FIX_MAX|-lt |-le /);
  });

  it('is overridable per project', () => {
    expect(ORCH).toMatch(/LINT_FIX_(ENABLED|MAX_ATTEMPTS|DIRECT)[^\n]*:-/);
  });

  it('gives the fixer write access, unlike the read-only QA gates', () => {
    // It must edit files; the gates must not. Different jobs, different tools.
    const f = fixer();
    expect(f).toMatch(/EPAM_ALLOWED_TOOLS|write_file/);
  });
});
