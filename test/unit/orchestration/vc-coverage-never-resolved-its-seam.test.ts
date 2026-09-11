/**
 * A GATE THAT ASKED NOBODY FOR ITS MODEL, AND SO NEVER RAN.
 *
 * Live 2026-09-09, run 20260908T215555Z, once per verification criterion — four times:
 *
 *   [vc-coverage] no model resolved for this seam — its ladder declares none, or the tier's
 *                 chain is unset.
 *   [vc-coverage] Refusing to substitute one: NO coverage verdict this run, rather than a
 *                 guessed model's.
 *
 * The refusal is right and must stay: a fabricated coverage verdict is acted on. But the premise
 * was wrong. The ladder was NOT unset — run-agent-orchestration.sh exports every
 * EPAM_MODEL_LADDER_<TIER> at startup and this script is a child of it, and vc-coverage is
 * declared on `highest` in the seam registry like 23 other seams that ran all night.
 *
 * The script read:
 *
 *     _vcc_model="${VC_COVERAGE_MODEL:-${EPAM_MODEL:-}}"
 *
 * commented "EPAM_MODEL carries this seam's resolved rung, which is what the others already
 * read" — but EPAM_MODEL is set by resolving a seam, and nothing resolves one for this gate. At
 * the top level of a phase EPAM_MODEL is whatever the last seam happened to leave, or empty. So
 * a brownfield-only gate refused itself on every run and reported it as a project
 * misconfiguration.
 *
 * seam_model_or_fail is the canonical answer — "identity -> seam -> ladder position -> the
 * project's tier -> that tier's declared startModel. Nothing here names a model, a provider or a
 * tier." lib/tc-writer-gate.sh already uses exactly this idiom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionProject, cleanupProvisioned } from '../../support/provisioned-project';

const ROOT = join(__dirname, '../../../');
const VCC = join(ROOT, 'orchestrations/scripts/vc-coverage-check.sh');

// A SEAM PROMPT RENDERS FROM THE PROJECT'S COPY. Without a provisioned project every case here
// dies on that refusal rather than on the model resolution it means to assert — which would make
// the whole file pass or fail for the wrong reason.
let PROJECT = '';
beforeAll(() => { PROJECT = provisionProject(['vc-coverage']); });
afterAll(() => { cleanupProvisioned(); });

/** The ladder POSITION vc-coverage actually declares, read from the registry rather than assumed. */
const LADDER: string = (() => {
  const reg = JSON.parse(readFileSync(
    join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
  const p = (reg.profiles || reg)['vc-coverage'];
  return (p && p.ladder) || '';
})();

/**
 * THE TIER THAT POSITION LANDS ON for the provisioned project — resolved by the engine's own rule
 * against the project's effective settings (engine, set, project), which is what model-ladders.sh
 * exports EPAM_MODEL_LADDER_<TIER> for. A seam declares a position; the set names the tier.
 */
function exportedTier(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveTierPosition } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
  const tier = resolveTierPosition(LADDER, { EPAM_PROJECT_CONFIG_DIR: PROJECT });
  if (!tier) throw new Error(`position '${LADDER}' resolves to no tier for the provisioned project`);
  return String(tier).toUpperCase();
}

function run(env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'vcc-'));
  const runner = join(d, 'runner.sh');
  // Records the model it was actually invoked with — evidence, not inference.
  writeFileSync(runner, `#!/usr/bin/env bash
cat > /dev/null
echo "INVOKED_WITH: $*" >> "${d}/calls.txt"
echo '{"covered":[],"uncovered":[],"verdict":"pass"}'
`);
  spawnSync('chmod', ['+x', runner]);

  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'AMSD-1919', title: 'case-insensitive email',
                verificationCriteria: ['emails compare case-insensitively'] }],
  }));
  const testFile = join(d, 'CheckoutForm.spec.tsx');
  writeFileSync(testFile, 'test("casing", () => { expect(1).toBe(1); });\n');

  const r = spawnSync('bash', [VCC, '--prd', prd, '--story', 'AMSD-1919',
                               '--test-file', testFile, '--out', join(d, 'out.json')], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: PROJECT,
           AI_RUNNER_CMD: runner, EPAM_MODEL: '', VC_COVERAGE_MODEL: '', ...env },
  });
  const calls = (() => { try { return readFileSync(join(d, 'calls.txt'), 'utf8'); } catch { return ''; } })();
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), calls,
           cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('vc-coverage resolves its own seam', () => {
  it('the registry really does declare a tier for it — the premise of the fix', () => {
    expect(LADDER, 'vc-coverage declares no ladder; this fix would be wrong').not.toBe('');
  });

  it('RESOLVES a model from the seam when EPAM_MODEL is empty, instead of refusing', () => {
    // The ladder the project declares for that tier, exactly as the pipeline exports it.
    const tier = exportedTier();
    const h = run({
      [`EPAM_MODEL_LADDER_${tier}`]: 'model-A=model-B',
      [`EPAM_MODEL_LADDER_${tier}_START`]: 'model-A',
    });
    try {
      expect(h.out, 'the gate still refused itself with the ladder plainly exported')
        .not.toMatch(/no model resolved for this seam/);
      expect(h.calls, 'the runner was never invoked').toMatch(/INVOKED_WITH:/);
      expect(h.calls, 'it did not run on the tier\'s declared start model')
        .toMatch(/--model model-A/);
    } finally { h.cleanup(); }
  });

  it('STILL refuses — never substitutes — when nothing declares a start model', () => {
    // The refusal is the valuable half and must survive the fix. Ladders live in the provider
    // SET since 2026-08-25, so a project that declares none inherits the set's; "nothing declares
    // one" means the whole stack is empty: EPAM_LLM_DEFAULTS_FILE names an empty declaration,
    // which the resolver honours as the explicit engine base and then reads no set.
    const empty = join(mkdtempSync(join(tmpdir(), 'vcc-empty-')), 'llm-defaults.json');
    writeFileSync(empty, '{}');
    const h = run({ EPAM_LLM_DEFAULTS_FILE: empty });
    try {
      expect(h.out).toMatch(/no model resolved for this seam/);
      expect(h.out).toMatch(/Refusing to substitute/);
      expect(h.calls, 'it invoked a model nothing declared').toBe('');
    } finally { h.cleanup(); }
  });

  it('an explicit VC_COVERAGE_MODEL still outranks the ladder', () => {
    const h = run({ VC_COVERAGE_MODEL: 'operator-choice' });
    try {
      expect(h.calls).toMatch(/--model operator-choice/);
    } finally { h.cleanup(); }
  });
});

/**
 * THE SECOND LAYER, found by running the fixed gate for real.
 *
 * With the seam resolving a model, the gate ran and every verdict still came back UNKNOWN. The
 * call was built as
 *
 *     bash "$AI_RUNNER_CMD" --provider "${ORCH_GATE_PROVIDER:-}" --model "$_vcc_model" 2>/dev/null
 *
 * and ORCH_GATE_PROVIDER is normally unset, so the gate passed `--provider ""`. Measured against
 * the real runner on 2026-09-09:
 *
 *     --provider ""  ->  llm-handler.sh: no provider configured.   rc=1, empty output
 *     flag omitted   ->  {"covered": true}                          rc=0
 *
 * An empty flag value is WORSE than no flag: llm-handler.sh re-derives the provider from the
 * active set when none is given, and an explicit empty string overwrites that correct answer.
 * code-review-cycle.sh was fixed for exactly this and carries its own test; this call site was
 * missed. `2>/dev/null` then discarded the one line that said why.
 */
describe('vc-coverage never passes an empty --provider', () => {
  it('OMITS the flag when no gate provider is configured', () => {
    const tier = exportedTier();
    const h = run({
      [`EPAM_MODEL_LADDER_${tier}`]: 'model-A=model-B',
      [`EPAM_MODEL_LADDER_${tier}_START`]: 'model-A',
      ORCH_GATE_PROVIDER: '',
    });
    try {
      expect(h.calls, 'the runner was never invoked').toMatch(/INVOKED_WITH:/);
      expect(h.calls, 'an empty --provider clobbers the runner\'s own resolution')
        .not.toMatch(/--provider(\s|$)/);
      expect(h.calls).toMatch(/--model model-A/);
    } finally { h.cleanup(); }
  });

  it('PASSES the flag when a gate provider IS configured', () => {
    const tier = exportedTier();
    const h = run({
      [`EPAM_MODEL_LADDER_${tier}`]: 'model-A=model-B',
      [`EPAM_MODEL_LADDER_${tier}_START`]: 'model-A',
      ORCH_GATE_PROVIDER: 'claude',
    });
    try {
      expect(h.calls).toMatch(/--provider claude/);
    } finally { h.cleanup(); }
  });
});

/**
 * A PRESENCE TEST CANNOT SEE WHAT ELSE THE SHELL SAID.
 *
 * The two tests above assert what argv carried and passed while the script was emitting
 * "local: can only be used in a function" on every criterion — the provider fix was written with
 * `local` at TOP LEVEL, where it is invalid. The array survived only by falling through to a
 * global. Caught by running the gate for real on 2026-09-09, not by the assertions that were
 * looking straight at it.
 */
describe('vc-coverage runs clean', () => {
  it('emits no shell errors of its own', () => {
    const tier = exportedTier();
    const h = run({
      [`EPAM_MODEL_LADDER_${tier}`]: 'model-A=model-B',
      [`EPAM_MODEL_LADDER_${tier}_START`]: 'model-A',
    });
    try {
      // Guard against a vacuous pass: the gate must actually have run.
      expect(h.calls).toMatch(/INVOKED_WITH:/);
      expect(h.out).not.toMatch(/local: can only be used in a function/);
      expect(h.out).not.toMatch(/command not found|unbound variable|syntax error/);
    } finally { h.cleanup(); }
  });
});
