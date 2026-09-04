/**
 * THE RUN MUST NOT MISREPORT ITS OWN GATES.
 *
 * Two separate reporting defects from the 2026-09-04 run. Neither changes what the pipeline DOES;
 * both change what the operator believes it is doing, which is how a real failure gets ignored.
 *
 * ── 1. The stage table announces the switch that would turn each gate OFF, next to a gate that is
 *       ON ─────────────────────────────────────────────────────────────────────────────────────
 *
 * _checklist_row prints its 4th argument as a parenthesised reason, unconditionally. For the
 * skip-toggle rows that argument is the variable that disables the step:
 *
 *     _checklist_row "5" "Regression guard" "$(... && echo SKIP || echo ACTIVE)" "SKIP_REGRESSION_GUARD=true"
 *
 * so a gate that is running prints:
 *
 *     5      Regression guard          ACTIVE (SKIP_REGRESSION_GUARD=true)
 *
 * which reads as "this gate is skipped, here is the proof". Eleven rows do it. The status is
 * computed and correct; the text beside it contradicts the status.
 *
 * The 4th argument is NOT always a toggle — several rows use it for the resolved model, which is
 * exactly what an operator wants on an ACTIVE row. So the rule is by SHAPE, not by a list of rows:
 * a reason that looks like `NAME=value` is a switch, and a switch only means something on a row
 * that is actually off. A model name never looks like that.
 *
 * ── 2. The coverage gate stands down once per stage, forever ────────────────────────────────────
 *
 *     [coverage-gate] <stage>: no pre-flight has gated this run — standing down
 *
 * printed for every stage of every run. The statement is TRUE — pre-flight measured nothing, so
 * the run is genuinely not gated — but repeated ~14 times it reads as a fault the operator should
 * act on, and it buries the one line that matters. Said once, with the reason, it is information.
 * Said fourteen times it is noise, and noise is where the next real message goes to die.
 *
 * THIS FILE DOES NOT TOUCH COVERAGE MEASUREMENT and must not be read as coverage work: the
 * stand-down still stands down, still returns 0, and enforces exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const GUARD = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');
const COVERAGE = join(REPO, 'orchestrations/scripts/lib/stage-coverage-gate.sh');

/**
 * Lift the real _checklist_row definition out of the script and execute it. The established
 * pattern for this codebase: run the actual function body against fixtures rather than assert on
 * source text, which would pass on a comment or a dead branch.
 */
function checklistRow(args: string[]): string {
  const src = readFileSync(GUARD, 'utf8');
  const start = src.indexOf('    _checklist_row() {');
  expect(start, '_checklist_row() was not found — this test has drifted from the script')
    .toBeGreaterThan(-1);
  const end = src.indexOf('\n    }\n', start);
  expect(end, 'the end of _checklist_row() was not found').toBeGreaterThan(start);
  const body = src.slice(start, end + 6);

  const dir = mkdtempSync(join(tmpdir(), 'checklist-row-'));
  try {
    const s = join(dir, 's.sh');
    writeFileSync(s, [
      '#!/bin/bash', 'set -uo pipefail',
      // The colour variables the row uses; empty so the output is plain text to assert on.
      'GREEN=""; YELLOW=""; CYAN=""; NC=""',
      body,
      `_checklist_row ${args.map((a) => JSON.stringify(a)).join(' ')}`,
    ].join('\n'));
    const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, `the row failed to render: ${r.stderr}`).toBe(0);
    return r.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the stage table does not tell the operator a live gate is off', () => {
  it('an ACTIVE row does not print the switch that would disable it', () => {
    const out = checklistRow(['5', 'Regression guard', 'ACTIVE', 'SKIP_REGRESSION_GUARD=true']);
    expect(out).toContain('ACTIVE');
    expect(out,
      'the row reads "ACTIVE (SKIP_REGRESSION_GUARD=true)" — the status says the gate is on and '
      + 'the text beside it says it is off. Eleven rows print this on every run.')
      .not.toContain('SKIP_REGRESSION_GUARD=true');
  });

  it('a SKIP row still names the switch — that is when it is the answer', () => {
    const out = checklistRow(['5', 'Regression guard', 'SKIP', 'SKIP_REGRESSION_GUARD=true']);
    expect(out,
      'a skipped gate must say WHY it is skipped, or the operator cannot tell a deliberate skip '
      + 'from a broken step')
      .toContain('SKIP_REGRESSION_GUARD=true');
  });

  it('a non-switch reason survives on an ACTIVE row — the model is what you want to see', () => {
    // Several rows pass the resolved model here. Suppressing that would hide the single most
    // useful fact on the line, and an unexpected rung is what an operator most needs to catch.
    const out = checklistRow(['1a', '  openspec (elaboration)', 'ACTIVE', 'claude-sonnet-5']);
    expect(out).toContain('claude-sonnet-5');
  });

  it('a COND row keeps its reason too', () => {
    const out = checklistRow(['4', 'Hybrid pre-coord', 'COND', 'ORCH_MODE=bash']);
    expect(out).toContain('ORCH_MODE=bash');
  });

  it('the real script has rows of both kinds — otherwise the rule above is theoretical', () => {
    const src = readFileSync(GUARD, 'utf8');
    const rows = src.split('\n').filter((l) => l.includes('_checklist_row "'));
    expect(rows.length, '_checklist_row is never called').toBeGreaterThan(5);
    expect(rows.filter((l) => /"[A-Z_]+=true"\s*$/.test(l)).length,
      'no switch-shaped reasons found; the defect this describes is not in the script')
      .toBeGreaterThan(0);
  });
});

describe('the coverage gate states its stand-down once, not once per stage', () => {
  /** Call require_stage_coverage for several stages in ONE shell, as a run does. */
  function standDownOutput(stages: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-standdown-'));
    try {
      const s = join(dir, 's.sh');
      writeFileSync(s, [
        '#!/bin/bash', 'set -uo pipefail',
        'export EPAM_COVERAGE_GATED=0',
        `. ${JSON.stringify(COVERAGE)}`,
        ...stages.map((st) => `require_stage_coverage ${JSON.stringify(st)} || echo "RC_NONZERO"`),
      ].join('\n'));
      const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
      return `${r.stdout}${r.stderr}`;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('says it once for a run, however many stages ask', () => {
    const out = standDownOutput(['spec', 'cpa', 'mint', 'writer', 'review', 'guard']);
    const said = (out.match(/standing down/g) || []).length;
    expect(said,
      'the stand-down is printed once per stage. Fourteen identical lines per run bury the one '
      + 'message that matters, and read as a fault rather than a state.')
      .toBe(1);
  });

  it('and it still says it — silence would be worse than repetition', () => {
    const out = standDownOutput(['spec']);
    expect(out,
      'the gate stood down and said nothing at all — an operator would believe coverage was enforced')
      .toMatch(/standing down/);
  });

  it('the stand-down still PASSES every stage — enforcement is unchanged', () => {
    const out = standDownOutput(['spec', 'cpa', 'mint']);
    expect(out,
      'a stage failed while standing down; this change must not alter what the gate permits')
      .not.toContain('RC_NONZERO');
  });
});
