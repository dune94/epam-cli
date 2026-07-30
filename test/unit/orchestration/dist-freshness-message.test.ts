/**
 * A guard whose explanation is destroyed when it fires gets misdiagnosed.
 *
 * Live 2026-07-30. mock3 failed in 171ms with:
 *
 *   AssertionError: lane 'mock-a' never ran:
 *   .../lib/dist-freshness.sh: line 40: error: command not found
 *   .../lib/dist-freshness.sh: line 42: error: command not found
 *   .../lib/dist-freshness.sh: line 44: error: command not found
 *   .../lib/dist-freshness.sh: line 45: error: command not found
 *
 * The guard was RIGHT — src/tools/builtin/WriteFile.ts had just been edited and
 * dist/ never rebuilt, so the new write-time reuse guard would not have
 * executed and the run would have "passed" without it. But every line of that
 * reasoning was replaced by shell noise, because this library is sourced by
 * callers that do not define the pipeline's own error() helper.
 *
 * What reached the operator named neither the stale bundle nor the file. The
 * failure it actually reported — "lane never ran" — points at the lane loop,
 * which was working perfectly.
 *
 * THE RULE: a library that diagnoses must not depend on its caller having
 * defined the means to speak. The fallback is three lines; without it the
 * guard's value is inverted at exactly the moment it pays off.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/dist-freshness.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A repo whose dist/ predates its src/ — the condition the guard exists for. */
function staleRepo() {
  const d = mkdtempSync(join(tmpdir(), 'distfresh-'));
  dirs.push(d);
  mkdirSync(join(d, 'src'), { recursive: true });
  mkdirSync(join(d, 'dist'), { recursive: true });
  writeFileSync(join(d, 'dist', 'epam.js'), '// built');
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(d, 'dist', 'epam.js'), old, old);
  writeFileSync(join(d, 'src', 'WriteFile.ts'), 'export const x = 1;');
  return d;
}

/** Source the library with NO caller-provided logging helpers — the live case. */
function runBare(repo: string) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; assert_dist_fresh ${JSON.stringify(repo)}`],
    { encoding: 'utf8', timeout: 30000 });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

describe('the stale-dist guard explains itself without help from its caller', () => {
  it('says dist is stale rather than "command not found"', () => {
    const { out } = runBare(staleRepo());
    expect(out, 'the diagnostic was destroyed — the operator sees shell noise ' +
      'and blames whatever ran next').not.toMatch(/command not found/);
    expect(out).toMatch(/dist\/ is STALE/);
  });

  it('names the source file that would not have executed', () => {
    // The single most useful fact: WHICH change would silently no-op.
    expect(runBare(staleRepo()).out).toMatch(/WriteFile\.ts/);
  });

  it('still tells the operator how to fix it', () => {
    const { out } = runBare(staleRepo());
    expect(out).toMatch(/tsup/);
    expect(out).toMatch(/EPAM_SKIP_DIST_CHECK=1/);
  });

  it('still blocks the run', () => {
    // Legibility must not have cost the guard its teeth.
    expect(runBare(staleRepo()).status, 'the guard stopped failing closed').toBe(1);
  });
});

describe('a caller that DOES define error() keeps its own formatting', () => {
  it('does not override the pipeline\'s logger', () => {
    const repo = staleRepo();
    const r = spawnSync('bash', ['-c',
      `error(){ printf 'PIPELINE-ERR: %s\\n' "$*" >&2; }; source ${JSON.stringify(LIB)}; ` +
      `assert_dist_fresh ${JSON.stringify(repo)}`],
      { encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out, 'the library clobbered the caller\'s logger — every pipeline ' +
      'diagnostic would lose its colour and prefix').toMatch(/PIPELINE-ERR: dist\/ is STALE/);
    expect(out).not.toMatch(/\[dist-freshness\]/);
  });
});

describe('it still passes a fresh build', () => {
  it('returns 0 when dist is newer than src', () => {
    const d = mkdtempSync(join(tmpdir(), 'distfresh-ok-'));
    dirs.push(d);
    mkdirSync(join(d, 'src'), { recursive: true });
    mkdirSync(join(d, 'dist'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const x = 1;');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(d, 'src', 'a.ts'), old, old);
    writeFileSync(join(d, 'dist', 'epam.js'), '// built');
    expect(runBare(d).status).toBe(0);
  });
});
