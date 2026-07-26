/**
 * Does the test actually cover every verification criterion?
 *
 * Live metrolinx 2026-07-26, run 7. Three VCs were written; the generated test
 * covered two — unprompted and well — and silently skipped the third, the
 * negative case:
 *
 *   "When a return-trip ticket has NO promo code applied, the Mozio email
 *    confirmation does NOT display a promo code discount amount"
 *
 * Nothing noticed. The bug-reproduction gate proves a test fails before the fix
 * and passes after; it says nothing about whether the test covers the criteria
 * the story was accepted against.
 *
 * A term-overlap version was built first and DELETED. Run against this exact
 * data it reported "0 of 3 uncovered", because the negative criterion shares
 * "return" and "trip" with the positive test asserting the discount IS applied.
 * Bag-of-words cannot represent negation, and special-casing "not" would hardcode
 * English into the engine. False assurance is worse than a known gap.
 *
 * So the judgement goes to a model — one closed question per criterion about two
 * artefacts that both exist, answered yes/no with a reason. Verification, not
 * generation; the same shape as the detective's evidence gate.
 *
 * It is ADVISORY and must never fail a run: the change has already been proven
 * RED→GREEN by execution, which is stronger evidence than a model's doubt.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/vc-coverage-check.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const VCS = [
  'When a return-trip ticket with a promo code is booked, the Mozio email confirmation displays the promo code discount amount for the return-trip ticket',
  'When an outbound-trip ticket with a promo code is booked, the Mozio email confirmation still displays the promo code discount amount correctly (no regression)',
  'When a return-trip ticket has no promo code applied, the Mozio email confirmation does not display a promo code discount amount for that ticket',
];

/** The two positive cases the run actually wrote — the negative one is missing. */
const TEST_SRC = `
describe('applyReportDiscountsService', () => {
  it('should apply the promo code discount to a return-trip Mozio dispatch', () => {
    expect(result?.report.price.discount?.amount.value).toBe(5);
  });
  it('should still apply the promo code discount to an outbound one-way Mozio dispatch', () => {
    expect(result?.report.price.discount?.amount.value).toBe(5);
  });
});
`;

/**
 * A stub model. `answers` maps a distinctive fragment of a criterion to the
 * verdict the model should return, so the harness controls the judgement while
 * the script's real parsing, looping and reporting are exercised.
 */
function run(opts: {
  vcs?: string[]; testSrc?: string | null;
  answers?: Array<{ covered: boolean; case?: string; why?: string }>;
  emit?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-cov-'));
  dirs.push(dir);

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'S-1', verificationCriteria: opts.vcs ?? VCS }],
  }));

  const testFile = join(dir, 'thing.spec.ts');
  if (opts.testSrc !== null) writeFileSync(testFile, opts.testSrc ?? TEST_SRC);

  // Stub runner: emits the next canned verdict on each invocation.
  const counter = join(dir, 'n');
  writeFileSync(counter, '0');
  const answers = opts.answers ?? [];
  const stub = join(dir, 'ai-run.sh');
  writeFileSync(stub, `#!/usr/bin/env bash
cat >/dev/null
n=$(cat ${JSON.stringify(counter)})
echo $((n+1)) > ${JSON.stringify(counter)}
${opts.emit !== undefined ? `printf '%s' ${JSON.stringify(opts.emit)}` :
  `case "$n" in
${answers.map((a, i) => `  ${i}) printf '%s' ${JSON.stringify(JSON.stringify(a))} ;;`).join('\n')}
  *) printf '%s' '{"covered":true,"case":"x","why":"y"}' ;;
esac`}
`);
  chmodSync(stub, 0o755);

  const out = join(dir, 'results.json');
  const r = spawnSync('bash', [SCRIPT, '--prd', prd, '--story', 'S-1',
                               '--test-file', testFile, '--out', out], {
    encoding: 'utf8', timeout: 40000,
    env: { ...process.env, AI_RUNNER_CMD: stub },
  });
  return {
    code: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    results: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8') || '[]') : null,
  };
}

describe('the criterion the run actually missed is reported', () => {
  it('flags the negative criterion the term-overlap version called covered', () => {
    const r = run({ answers: [
      { covered: true,  case: 'return-trip case' },
      { covered: true,  case: 'outbound case' },
      { covered: false, why: 'no case asserts the absence of a discount' },
    ]});
    expect(r.out, 'the uncovered criterion was not reported').toMatch(/UNCOVERED/);
    expect(r.out).toMatch(/VC_UNCOVERED=1 of 3/);
    expect(r.out, 'the reason is not surfaced').toMatch(/absence of a discount/);
  });

  it('reports full coverage when every criterion is covered', () => {
    const r = run({ answers: [{ covered: true }, { covered: true }, { covered: true }] });
    expect(r.out).toMatch(/VC_UNCOVERED=0 of 3/);
    // The per-criterion marker, not the summary token — 'VC_UNCOVERED=0' itself
    // contains the word.
    expect(r.out).not.toMatch(/\bUNCOVERED {2}/);
  });

  it('asks once per criterion — one closed question, not one bulk judgement', () => {
    const r = run({ answers: [{ covered: true }, { covered: false }, { covered: true }] });
    expect(r.results).toHaveLength(3);
  });
});

describe('it can never break a run', () => {
  it('exits 0 even when criteria are uncovered', () => {
    // The change is already proven RED→GREEN; a coverage opinion is weaker
    // evidence and must not override it.
    expect(run({ answers: [{ covered: false }, { covered: false }, { covered: false }] }).code).toBe(0);
  });

  it('exits 0 when the model returns nothing usable', () => {
    const r = run({ emit: '' });
    expect(r.code).toBe(0);
    expect(r.out, 'silence was counted as a gap').toMatch(/UNKNOWN/);
    expect(r.out, 'an unanswered criterion was counted as uncovered')
      .toMatch(/VC_UNCOVERED=0 of 3/);
  });

  it('exits 0 when the model emits prose instead of JSON', () => {
    const r = run({ emit: 'I think it is probably covered, roughly speaking.' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/UNKNOWN/);
  });

  it('exits 0 when there is no test file', () => {
    expect(run({ testSrc: null }).code).toBe(0);
  });

  it('exits 0 and says nothing when the story has no criteria', () => {
    const r = run({ vcs: [] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no verification criteria/i);
  });

  it('finds the verdict inside a chatty reply', () => {
    const r = run({ emit: 'Here is my assessment.\n{"covered": false, "why": "not tested"}\nDone.' });
    expect(r.out).toMatch(/UNCOVERED/);
  });

  it('says a coverage gap is not a correctness failure', () => {
    // Otherwise a reader treats it as "the fix is broken", which it is not.
    const r = run({ answers: [{ covered: false }, { covered: true }, { covered: true }] });
    expect(r.out).toMatch(/COVERAGE gap, not a correctness one/);
  });
});

describe('it is wired into the brownfield flow', () => {
  const ORCH = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('runs after the bug-reproduction gate PASSES', () => {
    // Coverage is only a meaningful question once the test is known to
    // reproduce the bug; before that there is nothing worth measuring.
    const gate = ORCH.indexOf('brownfield-repro-test-gate.sh');
    const check = ORCH.indexOf('vc-coverage-check.sh');
    expect(check, 'the coverage check is never invoked').toBeGreaterThan(-1);
    expect(check, 'it runs before the repro gate, so it may judge an unproven test')
      .toBeGreaterThan(gate);
  });

  it('takes the test file from the manifest, not from a declared list', () => {
    const i = ORCH.indexOf('vc-coverage-check.sh');
    expect(ORCH.slice(Math.max(0, i - 600), i + 400),
      'it reads a predicted file list rather than what the run produced')
      .toMatch(/story_outputs_tests/);
  });

  it('cannot fail the phase', () => {
    // From the -x guard through the end of the invocation, including its
    // line continuations.
    const i = ORCH.indexOf('vc-coverage-check.sh');
    expect(ORCH.slice(i, i + 900), 'the invocation is not guarded').toMatch(/\|\| true/);
  });
});
