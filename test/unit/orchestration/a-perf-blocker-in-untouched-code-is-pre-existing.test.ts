/**
 * A PERF BLOCKER IN CODE THE STORY DID NOT TOUCH IS PRE-EXISTING, NOT THE STORY'S.
 *
 * AMSD-2974 run 9, live iteration 1 (2026-10-13 18:1xZ): metrolinx carried NO change (the plan gives it none, the
 * writer did not run, the branch equals its baseline), yet perf-sentinel failed the lane on a "confirmed performance
 * blocker" in src/components/CslpAutoInjector/CslpAutoInjector.tsx — existing Contentstack live-preview code, unrelated
 * to the story. lib/handlers/perf.py counted a blocker whenever its codeSnippet was found in the real file, never
 * asking whether the change touched that file; self-heal then added ACs to the story for unrelated code.
 *
 * EXECUTED: the real perf.py on a real git repository with the lane's phase baseline (LOG_DIR/phase-baseline-sha.txt):
 * a blocker in an untouched file, one in a file the story changed, and one with no baseline recorded.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PERF = join(__dirname, '../../../orchestrations/scripts/lib/handlers/perf.py');
const UNTOUCHED = 'const observer = new MutationObserver(() => { inject(); });';
const CHANGED = 'items.forEach((a) => items.forEach((b) => compare(a, b)));';

function estate(opts: { changeStoryFile: boolean; baseline: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'perf-scope-'));
  const repo = join(d, 'repo'); const logs = join(d, 'logs'); mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(logs);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  writeFileSync(join(repo, 'src/Untouched.tsx'), `${UNTOUCHED}\n`);
  writeFileSync(join(repo, 'src/Story.tsx'), 'export const a = 1;\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  if (opts.baseline) writeFileSync(join(logs, 'phase-baseline-sha.txt'), git('rev-parse', 'HEAD').trim());
  if (opts.changeStoryFile) { writeFileSync(join(repo, 'src/Story.tsx'), `${CHANGED}\n`); git('commit', '-qam', 'S-1: story complete (1 file(s))'); }
  return { repo, logs };
}

function verdict(e: { repo: string; logs: string }, file: string, snippet: string) {
  const log = join(e.logs, 'perf-sentinel-core.log');
  writeFileSync(log, `perf output\n${JSON.stringify({ agent: 'perf-sentinel', verdict: 'fail', findings: [{ severity: 'blocker', file, line: 1, codeSnippet: snippet }] })}\n`);
  return spawnSync('python3', [PERF, log, e.repo], { encoding: 'utf8', env: { ...process.env, LOG_DIR: e.logs } }).stdout.trim();
}

describe('a perf blocker counts only in code the story changed', () => {
  it('a real blocker in a file the story did NOT touch (metrolinx, no diff) is pre-existing — not counted', () => {
    expect(verdict(estate({ changeStoryFile: false, baseline: true }), 'src/Untouched.tsx', UNTOUCHED)).toBe('0');
  });

  it('NEGATIVE: a real blocker in a file the story changed still fails the gate', () => {
    expect(verdict(estate({ changeStoryFile: true, baseline: true }), 'src/Story.tsx', CHANGED)).toBe('1');
  });

  it('NEGATIVE: with no baseline recorded the change cannot be told apart — the blocker counts, as before', () => {
    expect(verdict(estate({ changeStoryFile: false, baseline: false }), 'src/Untouched.tsx', UNTOUCHED)).toBe('1');
  });
});
