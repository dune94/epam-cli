/**
 * A STORY THE PLAN GIVES THIS CODELINE NO CHANGE NEVER REACHES THE WRITER.
 *
 * Live 2026-10-07 (AMSD-2974, upexpress): the plan gave upexpress no change — it receives the library's 7.x back-port —
 * but its lane still ran the writer, which worked from the story's pre-plan spec (12 declared deliverables, package.json
 * among them) and edited package.json, locale files and components against the plan, attempt after attempt.
 * Operator, 2026-10-07: such a story is proved, not written. The lane's own gates prove it (its worktrees build
 * against the provider's release line; Step 19 type-checks against the baseline); the writer is not run at all.
 *
 * EXECUTED: the real implement_story (lib/story-attempt.sh). Every helper it would call is undefined here and recorded
 * by bash's command_not_found_handle, so the test sees exactly what implement_story reaches.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function implement(change: string | null, branch: 'clean' | 'stray' | null = null) {
  const d = mkdtempSync(join(tmpdir(), 'no-writer-')); dirs.push(d);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', ...(change === null ? {} : { overallPlan: {
    codelines: [{ codeline: 'site', part: 'p', order: 2 }],
    packages: [{ package: '@s/lib', providedBy: 'lib', releaseLines: [], consumers: [{ codeline: 'site', declaredRange: '^1', receivesVia: '1.0.1', usage: [], change }] }],
  } }) }] }));
  // The codeline: on its story branch, clean or carrying edits from earlier attempts.
  let root = '';
  if (branch) {
    root = join(d, 'site'); spawnSync('git', ['init', '-q', '-b', 'develop', root]);
    const git = (...a: string[]) => spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    writeFileSync(join(root, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'base');
    writeFileSync(join(d, 'phase-baseline-sha.txt'), git('rev-parse', 'HEAD').stdout.trim());
    git('checkout', '-q', '-b', 'bugfix/AI-S-1');
    if (branch === 'stray') { writeFileSync(join(root, 'a.txt'), 'stray edit\n'); git('commit', '-qam', 'an earlier attempt'); }
  }
  const calls = join(d, 'calls');
  const script = [
    // The first helper implement_story reaches is recorded and ends the run: whether it got PAST the plan is the question.
    `command_not_found_handle() { echo "$1" >> ${JSON.stringify(calls)}; kill -9 $$; }`,
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }; success() { echo "OK: $*"; }; info() { :; }',
    shellFunction(join(SCRIPTS, 'lib/story-attempt.sh'), 'implement_story'),
    'implement_story S-1; echo "RC=$?"',
  ].join('\n');
  // implement_story is longer than one argument may be (E2BIG under bash -c): run it from a file.
  const sh = join(d, 'implement.sh'); writeFileSync(sh, script);
  const r = spawnSync('bash', [sh], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PRD_FILE: prd, MAIN_PRD_FILE: prd, EPAM_CODELINE: 'site', SCRIPT_DIR: SCRIPTS, NODE_BIN: process.execPath, LOG_DIR: d, MAX_RETRIES: '0', ...(root ? { PROJECT_ROOT: root } : {}) },
  });
  const called = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { out: (r.stdout || '') + (r.stderr || ''), called, rc: Number((/RC=(\d+)/.exec(r.stdout || '') || [])[1] ?? -1) };
}

describe('the writer is not run for a story the plan gives this codeline no change', () => {
  it('plan: exactly none → returns success before anything is invoked, and says why', () => {
    const { out, called, rc } = implement('none');
    expect(rc, out).toBe(0);
    expect(out).toMatch(/plan gives site no change — no writer is run/);
    expect(called, `implement_story reached: ${called.join(', ')}`).toEqual([]);
  });

  // Live AMSD-2974 run 10 (2026-10-08): upexpress's branch still carried an earlier attempt's edits (lint script,
  // import paths); the reviewer asked for them reverted, and the writer — skipped for "no change" — never could.
  it('plan: none, and the branch carries no change of its own → skipped', () => {
    const { called, rc } = implement('none', 'clean');
    expect(rc).toBe(0);
    expect(called).toEqual([]);
  });
  it('plan: none, but the branch carries edits from earlier attempts → the writer runs, to bring it to the plan', () => {
    const { out, called } = implement('none', 'stray');
    expect(out).not.toMatch(/no writer is run/);
    expect(out).toMatch(/carries changes of its own/);
    expect(called.length, 'the writer was skipped with stray edits on the branch').toBeGreaterThan(0);
  });

  it('plan: a change → the story goes on to its attempts as before', () => {
    const { out, called } = implement('rename the toast prop');
    expect(out).not.toMatch(/no writer is run/);
    expect(called.length, 'implement_story stopped before its attempts').toBeGreaterThan(0);
  });

  it('no plan → the story goes on to its attempts as before', () => {
    const { out, called } = implement(null);
    expect(out).not.toMatch(/no writer is run/);
    expect(called.length).toBeGreaterThan(0);
  });
});
