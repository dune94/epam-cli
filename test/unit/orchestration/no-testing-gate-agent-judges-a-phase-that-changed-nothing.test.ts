/**
 * NO TESTING-GATE AGENT IS CALLED TO JUDGE A PHASE THAT CHANGED NOTHING.
 *
 * AMSD-2974 run 9 (2026-10-13): on site lanes the plan gives no change, spec validator, mutant hunter, fuzz, perf and
 * runtime boundary were each paid to judge an empty diff — the runtime-boundary agent itself answered "there are no
 * changed source files to analyze". Operator: "Every LLM call must be for a reason". A phase that changed nothing
 * against its recorded baseline calls none of them; without a recorded baseline nothing is skipped.
 *
 * EXECUTED: the real run_testing_gates (lib/gates-testing.sh) on a real git repository, stopped at the line that
 * starts the agents — a phase with no change, one with a committed change, and one with no recorded baseline.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function gates(opts: { change: boolean; baseline: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'gates-nochange-')); dirs.push(d);
  const repo = join(d, 'repo'); const logs = join(d, 'logs'); mkdirSync(repo); mkdirSync(logs);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('init', '-q', '-b', 'develop'); git('add', '.'); git('commit', '-qm', 'base');
  if (opts.baseline) writeFileSync(join(logs, 'phase-baseline-sha.txt'), `${git('rev-parse', 'HEAD')}\n`);
  if (opts.change) { writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n'); git('commit', '-qam', 'S-1: story complete (1 file(s))'); }
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1' }] }));
  // log() is where the agents start ("Running testing gates"): reaching it means they would have been called.
  const r = spawnSync('bash', ['-c', `info(){ echo "INFO $*"; }; warning(){ :; }; error(){ :; }; success(){ :; }
step_emit(){ echo "STEP $1 $2"; }; is_truthy(){ [ "$1" = true ] || [ "$1" = 1 ]; }
log(){ case "$*" in *"Running testing gates"*) echo "AGENTS-STARTED"; exit 0;; esac; }
source ${JSON.stringify(join(SCRIPTS, 'lib/gates-testing.sh'))}
run_testing_gates core; echo "RC=$?"`],
  { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOG_DIR: logs, PROJECT_ROOT: repo, PRD_FILE: prd, SCRIPT_DIR: SCRIPTS, SKIP_TESTING_GATES: '' } });
  return r.stdout + r.stderr;
}

describe('no testing-gate agent judges a phase that changed nothing', () => {
  it('a phase with no change against its baseline: no agent starts, every gate step is skipped and says why', () => {
    const out = gates({ change: false, baseline: true });
    expect(out).not.toContain('AGENTS-STARTED');
    expect(out).toContain('RC=0');
    expect(out).toMatch(/changed nothing against its baseline/);
    expect((out.match(/^STEP 22[a-f] skip$/gm) || []).length).toBe(6);
  });

  it('NEGATIVE: a phase with a committed change still starts the agents', () => {
    expect(gates({ change: true, baseline: true })).toContain('AGENTS-STARTED');
  });

  it('NEGATIVE: with no recorded baseline nothing is skipped', () => {
    expect(gates({ change: false, baseline: false })).toContain('AGENTS-STARTED');
  });
});
