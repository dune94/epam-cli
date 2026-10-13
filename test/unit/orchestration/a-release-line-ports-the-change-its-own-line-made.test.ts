/**
 * A RELEASE LINE PORTS THE CHANGE ITS OWN LINE MADE — ITS WRITER AND ITS REVIEWERS ARE GIVEN THAT CHANGE.
 *
 * AMSD-2974 run 9 (2026-10-13): cx-shared's 8.x change grew in its own review and self-heal — header-measured top-right
 * placement, pointer-events off the empty container, the close click not propagating. The 7.x back-port's writer and
 * reviewer were given the plan's one-line summary of what the line carries, written before any code existed; nothing
 * gave either of them the 8.x change. The back-port carried a fraction of it and was approved. Operator: "to have two
 * shared changes with different code and reviewer passed without comparing two code lines is insane."
 *
 * EXECUTED: the real _run_release_lines (lib/release-lines.sh) on a real git repository — its own line committed after
 * the lane's phase baseline — with a phase runner that renders, in the line's own environment, exactly what the
 * writer is published (fix-plan.js <prd> <story>) and what both diff reviewers are given (fix-plan.js --review-shared).
 * NEGATIVES: an own line with no committed change gives no port section; the own line's pass is never given one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const FIX_PLAN = join(SCRIPTS, 'lib/producers/fix-plan.js');
const LOGS = 'warning() { echo "WARN: $*"; }; error() { echo "ERROR: $*"; }; success() { :; }; info() { :; }; log() { echo "LOG: $*"; }';
const HEADING = 'THE CHANGE THIS RELEASE LINE PORTS';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const prd = {
  project: { outputDir: '/w/lib', outputDirs: [{ codeline: 'lib', path: '/w/lib' }, { codeline: 'site', path: '/w/site' }] },
  implementationOrder: { core: ['S-1'] },
  stories: [{
    id: 'S-1', phase: 'core', codeline: 'lib', codelines: ['lib', 'site'], status: 'completed', completed: true, passes: true,
    overallPlan: {
      codelines: [{ codeline: 'lib', part: 'fix the toast', order: 1 }, { codeline: 'site', part: 'none', order: 2 }],
      packages: [{ package: '@scope/lib', providedBy: 'lib', consumers: [], releaseLines: [
        { line: '2.x', base: 'v2.0.0', version: '2.1.0', onCodelineBase: true },
        { line: '1.x', base: 'v1.0.0', version: '1.0.1', onCodelineBase: false, carries: 'the same role fix' }] }],
    },
  }],
};

function estate(ownLineCommits: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'line-port-')); dirs.push(d);
  const wt = join(d, 'lib'); mkdirSync(wt);
  const git = (...a: string[]) => execFileSync('git', ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
  writeFileSync(join(wt, 'Toast.tsx'), 'position: BOTTOM_RIGHT\n');
  git('init', '-q', '-b', 'AI-S-1'); git('add', '.'); git('commit', '-qm', 'base'); git('tag', 'v1.0.0');
  const laneLog = join(d, 'lanes/lib'); mkdirSync(laneLog, { recursive: true });
  writeFileSync(join(laneLog, 'phase-baseline-sha.txt'), `${git('rev-parse', 'HEAD')}\n`);
  if (ownLineCommits) {
    writeFileSync(join(wt, 'Toast.tsx'), 'position: TOP_RIGHT\npointerEvents: "none"\nonClick: (e) => { e.stopPropagation(); }\n');
    git('commit', '-qam', 'S-1: story complete (1 file(s))');
  }
  const prdFile = join(d, 'lane-prd.json'); writeFileSync(prdFile, JSON.stringify(prd));
  const out = join(d, 'rendered'); mkdirSync(out);
  // The lane's phase run, as the line pass invokes it: render what the writer and the reviewers get, in its environment.
  const runner = join(d, 'phase-runner.sh');
  writeFileSync(runner, `#!/bin/bash
"$NODE_BIN" ${JSON.stringify(FIX_PLAN)} "$PRD_FILE" S-1 > ${JSON.stringify(out)}/writer.txt
"$NODE_BIN" ${JSON.stringify(FIX_PLAN)} --review-shared "$PRD_FILE" S-1 > ${JSON.stringify(out)}/reviewer.txt
git -C "$PROJECT_ROOT" checkout -q -B "AI-S-1$EPAM_BRANCH_SUFFIX"
`);
  chmodSync(runner, 0o755);
  const r = spawnSync('bash', ['-c', `${LOGS}\nSCRIPT_DIR=${JSON.stringify(SCRIPTS)}\nNODE_BIN=${JSON.stringify(process.execPath)}\nexport NODE_BIN\n. ${JSON.stringify(join(SCRIPTS, 'lib/release-lines.sh'))}\n_run_release_lines lib ${JSON.stringify(prdFile)} ${JSON.stringify(wt)} ${JSON.stringify(laneLog)} /dev/null "" ${JSON.stringify(runner)}`],
    { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: '', LOG_DIR: d, EPAM_MAIN_LINE_CHANGE: '', EPAM_RELEASE_LINE: '' } });
  const read = (f: string) => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : '');
  return { r, prdFile, writer: read('writer.txt'), reviewer: read('reviewer.txt') };
}

describe('a release line ports the change its own line made', () => {
  it('the 1.x line\'s writer and both reviewers are given the own line\'s committed change, verbatim', () => {
    const e = estate(true);
    expect(e.r.status, e.r.stdout + e.r.stderr).toBe(0);
    for (const [who, text] of [['writer', e.writer], ['reviewer', e.reviewer]] as const) {
      // Not vacuous: the line pass ran and rendered the plan.
      expect(text, `${who} got nothing:\n${e.r.stdout}${e.r.stderr}`).toContain('THE OVERALL PLAN');
      expect(text, who).toContain(HEADING);
      expect(text, who).toContain('release line 1.x');
      expect(text, who).toContain('(AI-S-1)');
      for (const hunk of ['-position: BOTTOM_RIGHT', '+position: TOP_RIGHT', '+pointerEvents: "none"', 'e.stopPropagation()']) expect(text, `${who}: ${hunk}`).toContain(hunk);
    }
  });

  it('NEGATIVE: an own line that committed nothing gives the line no port section — the plan alone, as before', () => {
    const e = estate(false);
    expect(e.r.status, e.r.stdout + e.r.stderr).toBe(0);
    expect(e.writer).toContain('THE OVERALL PLAN');
    expect(e.writer).not.toContain(HEADING);
    expect(e.reviewer).toContain('THE OVERALL PLAN');
    expect(e.reviewer).not.toContain(HEADING);
  });

  it('NEGATIVE: the own line\'s pass (no release line) is never given a port section', () => {
    const e = estate(true);
    const own = spawnSync(process.execPath, [FIX_PLAN, '--review-shared', e.prdFile, 'S-1'], { encoding: 'utf8', env: { ...process.env, EPAM_RELEASE_LINE: '', EPAM_MAIN_LINE_CHANGE: '' } });
    expect(own.stdout).toContain('THE OVERALL PLAN');
    expect(own.stdout).not.toContain(HEADING);
  });
});
