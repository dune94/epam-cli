/**
 * A MODEL IS CHECKED AFTER IT IS WRITTEN, NOT ONLY BEFORE.
 *
 * Operator, 2026-09-06: "fix the coordinator bug for all sets."
 *
 * Step 7's off-ladder guard ran only BEFORE the coordinator, and its selector is
 * `(.model // "") != ""` — so a story with no model YET matched nothing, and the coordinator then
 * assigned one with nothing left to check it. Validate-then-write, in that order, is not
 * validation: it inspects the state the writer is about to replace.
 *
 * Live 2026-09-05, run 20260905T172837Z on the claude-only set — the successful run's own PRD
 * snapshots: model=undefined at the pause-1 checkpoint, model=undefined before CPA,
 * model="MiniMax-M3"/aiProvider="minimax" after step 7. MiniMax-M3 appears zero times in
 * llm-defaults.claude.json. Pre-flight refused to start the writer, correctly — after the run had
 * already reached that point. The workaround was SKIP_PRD_MODEL_COORDINATOR=1 on ONE set; the
 * defect stayed live on every other.
 *
 * THREE WRITERS land on the PRD in that step: the coordinator, its corrective-note retries, and
 * mc-fallback.py's post-condition default. The enforcement now runs after all of them, and outside
 * the skip branch — because the set that skips the coordinator can still carry an off-ladder model
 * from an earlier run, and that set is where this was actually paid for.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineSource } from '../../lib/engine-source';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const LADDER = ['claude-opus-4-6', 'claude-sonnet-4-6'];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A NODE_BIN that answers only the two ladder handlers, exactly as the real ones do. */
function fakeNode(dir: string, models: string[] | null) {
  const f = join(dir, 'fake-node');
  writeFileSync(f, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    `  *ladder-models.js)    printf '%s' ${JSON.stringify(models === null ? '' : JSON.stringify(models))} ;;`,
    `  *ladder-providers.js) printf '%s' '["anthropic"]' ;;`,
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
  chmodSync(f, 0o755);
  return f;
}

/** Lifts the real _mc_enforce_ladder and runs it over a PRD on disk. */
function enforce(stories: any[], opts: { models?: string[] | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories }, null, 2));
  const src = engineSource(ORCH);
  const start = src.indexOf('_mc_enforce_ladder() {');
  const end = src.indexOf('\n}\n', start) + 3;
  expect(start, 'the function was not found — the test is measuring nothing').toBeGreaterThan(0);
  // _mc_enforce_ladder ends by correcting the provider the same way; lift that too.
  const pStart = src.indexOf('_mc_enforce_providers() {');
  const pEnd = src.indexOf('\n}\n', pStart) + 3;
  expect(pStart, '_mc_enforce_providers was not found').toBeGreaterThan(0);
  const script = join(dir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'warning() { printf "WARN %s\\n" "$*"; }',
    `NODE_BIN=${JSON.stringify(fakeNode(dir, opts.models === undefined ? LADDER : opts.models))}`,
    `SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}`,
    src.slice(start, end),
    src.slice(pStart, pEnd),
    `_mc_enforce_ladder ${JSON.stringify(prd)} "test"`,
  ].join('\n'));
  let out = '';
  try { out = execFileSync('bash', [script], { encoding: 'utf8', timeout: 60_000 }); }
  catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  return { out, prd: JSON.parse(engineSource(prd)) };
}

const modelOf = (p: any, id: string) => p.stories.find((s: any) => s.id === id)?.model;
const providerOf = (p: any, id: string) => p.stories.find((s: any) => s.id === id)?.aiProvider;

describe('the PROVIDER is corrected with the model, not left behind', () => {
  // regintel 20260916T200108Z, 2026-09-17 (claude set): nine stories carried aiProvider=minimax
  // with model=claude-haiku — the model had been put on the ladder, the provider had not — and
  // pre-flight refused the resume on "test-authoring stories on a provider the registry rules out".
  it("run 200108Z's shape: an off-set provider becomes the set's first, on every offending story", () => {
    const { prd, out } = enforce([
      { id: 'REGI-002', model: 'claude-opus-4-6', aiProvider: 'minimax' },
      { id: 'REGI-003', model: 'MiniMax-M3', aiProvider: 'minimax' },
      { id: 'REGI-001a', model: 'claude-opus-4-6', aiProvider: 'anthropic' },
    ]);
    expect(providerOf(prd, 'REGI-002')).toBe('anthropic');
    expect(providerOf(prd, 'REGI-003')).toBe('anthropic');
    expect(modelOf(prd, 'REGI-003')).toBe('claude-opus-4-6');
    expect(providerOf(prd, 'REGI-001a')).toBe('anthropic');
    expect(out).toMatch(/provider this set cannot route .*for: REGI-002, REGI-003/);
    expect(out).not.toMatch(/cannot route .*REGI-001a/);
  });

  it("the provider is corrected even when EVERY model is already on the ladder (the 2.0.48 resume's state: models corrected by an earlier pass, providers still foreign)", () => {
    const { prd, out } = enforce([
      { id: 'REGI-002', model: 'claude-opus-4-6', aiProvider: 'minimax' },
      { id: 'REGI-003', model: 'claude-sonnet-4-6', aiProvider: 'minimax' },
    ]);
    expect(providerOf(prd, 'REGI-002')).toBe('anthropic');
    expect(providerOf(prd, 'REGI-003')).toBe('anthropic');
    expect(out).toMatch(/cannot route/);
    expect(out).not.toMatch(/model on no declared ladder/);
  });

  it('a story with NO provider is left for the coordinator; an on-set provider is untouched', () => {
    const { prd, out } = enforce([
      { id: 'A', model: 'claude-opus-4-6' },
      { id: 'B', model: 'claude-opus-4-6', aiProvider: 'anthropic' },
    ]);
    expect(providerOf(prd, 'A')).toBeUndefined();
    expect(providerOf(prd, 'B')).toBe('anthropic');
    expect(out).not.toMatch(/cannot route/);
  });
});

describe('the ladder enforcement, as an artefact change', () => {
  it('rewrites an off-ladder model to the ladder\'s opening model', () => {
    const r = enforce([{ id: 'AMSD-1919', model: 'MiniMax-M3', aiProvider: 'minimax' }]);
    expect(modelOf(r.prd, 'AMSD-1919'),
      'the live failure: a model on no declared ladder survived step 7').toBe(LADDER[0]);
  });

  it('leaves an ON-ladder model alone — including one that is not the first rung', () => {
    const r = enforce([{ id: 'A', model: LADDER[1] }]);
    expect(modelOf(r.prd, 'A'),
      'a legitimate escalated model was reset to the opening rung, undoing the climb')
      .toBe(LADDER[1]);
  });

  it('leaves a story with NO model untouched — assignment is not this step\'s job', () => {
    const r = enforce([{ id: 'A' }, { id: 'B', model: '' }]);
    expect(modelOf(r.prd, 'A')).toBeUndefined();
    expect(modelOf(r.prd, 'B')).toBe('');
  });

  it('corrects only the offending stories, and touches nothing else on them', () => {
    const r = enforce([
      { id: 'A', model: 'MiniMax-M3', aiProvider: 'minimax', reasoningEffort: 'high', status: 'pending' },
      { id: 'B', model: LADDER[1], status: 'done' },
    ]);
    expect(modelOf(r.prd, 'A')).toBe(LADDER[0]);
    expect(modelOf(r.prd, 'B')).toBe(LADDER[1]);
    const a = r.prd.stories.find((s: any) => s.id === 'A');
    expect(a.reasoningEffort, 'a neighbouring field was lost in the rewrite').toBe('high');
    expect(a.status).toBe('pending');
    expect(r.prd.stories.length, 'a story disappeared from the PRD').toBe(2);
  });

  it('SAYS SO — a silent correction is a deviation discovered a run later', () => {
    const r = enforce([{ id: 'AMSD-1919', model: 'MiniMax-M3' }]);
    expect(r.out).toMatch(/no declared ladder/);
    expect(r.out).toMatch(/AMSD-1919/);
  });

  it('NAMES ONLY WHAT IT CORRECTED — the report and the rewrite are one decision', () => {
    /**
     * The story list in the warning and the rewrite itself are two jq expressions carrying the
     * same condition. Let them drift and the operator is told story X was corrected while X is
     * untouched — a correction report that cannot be checked against the PRD is worse than none,
     * because it is the only evidence anyone reads.
     */
    const r = enforce([
      { id: 'OFF', model: 'MiniMax-M3' },
      { id: 'NOMODEL' },
      { id: 'EMPTY', model: '' },
      { id: 'OK', model: LADDER[1] },
    ]);
    expect(r.out).toMatch(/OFF/);
    expect(r.out, 'a story with no model was reported as corrected — it was not touched')
      .not.toMatch(/NOMODEL/);
    expect(r.out, 'a story with an empty model was reported as corrected').not.toMatch(/EMPTY/);
    expect(r.out, 'a story already on the ladder was reported as corrected').not.toMatch(/\bOK\b/);
    expect(modelOf(r.prd, 'NOMODEL')).toBeUndefined();
    expect(modelOf(r.prd, 'EMPTY')).toBe('');
  });

  it('AN UNRESOLVABLE LADDER CORRECTS NOTHING — it must not blank a working PRD', () => {
    // Rewriting every model to "" because the ladder could not be read would break a PRD that was
    // fine. The resolution failure is reported by the refusal in the step itself.
    for (const models of [null, [] as string[]]) {
      const r = enforce([{ id: 'A', model: 'MiniMax-M3' }], { models });
      expect(modelOf(r.prd, 'A'),
        'an unresolvable ladder rewrote the PRD anyway').toBe('MiniMax-M3');
    }
  });

  it('is IDEMPOTENT — a second pass selects nothing and rewrites nothing', () => {
    // It now runs on both sides of the coordinator, so running twice must be a no-op.
    const r1 = enforce([{ id: 'A', model: 'MiniMax-M3' }]);
    const r2 = enforce(r1.prd.stories);
    expect(modelOf(r2.prd, 'A')).toBe(LADDER[0]);
    expect(r2.out, 'the second pass reported a correction it did not need to make')
      .not.toMatch(/no declared ladder/);
  });
});

describe('the enforcement runs AFTER the writers, on every set', () => {
  /**
   * The skipped path is the LIVE path for the claude set: metrolinx sets
   * SKIP_PRD_MODEL_COORDINATOR=1, which is the workaround this fix replaces. If the enforcement
   * sat inside the else, that set would keep an off-ladder model written by an earlier run — the
   * exact value pre-flight then refuses to launch on.
   */
  function runStep7(stories: any[], env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'step7-'));
    dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories }, null, 2));
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'profiles.json'), '{}');

    const src = engineSource(ORCH);
    const fnStart = src.indexOf('_mc_enforce_ladder() {');
    const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
    const stepStart = src.indexOf('_emit_agent start "prd-model-coordinator"');
    const stepEnd = src.indexOf('step_emit "7" "pass"', stepStart);
    expect(stepStart, 'step 7 was not found').toBeGreaterThan(0);
    expect(stepEnd, 'the end of step 7 was not found').toBeGreaterThan(stepStart);

    const script = join(dir, 'drive.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash', 'set -uo pipefail',
      'info() { printf "%s\\n" "$*"; }',
      'warning() { printf "WARN %s\\n" "$*"; }',
      'error() { printf "ERR %s\\n" "$*"; }',
      '_emit_agent() { :; }', 'step_emit() { :; }',
      'is_truthy() { case "${1:-}" in 1|true|yes|TRUE|YES) return 0 ;; *) return 1 ;; esac; }',
      `NODE_BIN=${JSON.stringify(fakeNode(dir, LADDER))}`,
      `SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}`,
      `PRD_FILE=${JSON.stringify(prd)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prd)}`,
      `EPAM_AGENTS_DIR=${JSON.stringify(join(dir, 'agents'))}`,
      `LOG_DIR=${JSON.stringify(dir)}`,
      'CURRENT_PHASE=presplit', 'PHASE=presplit',
      src.slice(fnStart, fnEnd),
      src.slice(stepStart, stepEnd),
    ].join('\n'));

    let out = '';
    try {
      out = execFileSync('bash', [script], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, ...env },
      });
    } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
    return { out, prd: JSON.parse(engineSource(prd)) };
  }

  it('SKIPPED SET — an off-ladder model is still corrected', () => {
    const r = runStep7([{ id: 'AMSD-1919', model: 'MiniMax-M3', aiProvider: 'minimax',
      reasoningEffort: 'high', status: 'pending', phase: 'presplit' }],
    { SKIP_PRD_MODEL_COORDINATOR: '1' });
    expect(modelOf(r.prd, 'AMSD-1919'),
      'the set that skips the coordinator kept a model on no declared ladder — the next launch '
      + 'is refused by pre-flight and the operator is told nothing here').toBe(LADDER[0]);
  });

  it('SKIPPED SET — an on-ladder model is left alone', () => {
    const r = runStep7([{ id: 'A', model: LADDER[1], status: 'pending', phase: 'presplit' }],
      { SKIP_PRD_MODEL_COORDINATOR: '1' });
    expect(modelOf(r.prd, 'A')).toBe(LADDER[1]);
  });
});
