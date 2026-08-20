// THE PRE-FLIGHT CHECKED THE SOURCE AND NOT WHAT ACTUALLY RUNS.
//
// 2026-08-20. preflight-static.sh reported PASS, and the launcher then refused to start:
//
//   ✗ [preflight] dist/epam.js is OLDER than createTools.ts — the pipeline would run a stale binary
//
// The plugin-strictness fix (3b51ab9) was written in TypeScript, tested, committed — and never
// built. Every test in the suite reads src/, so a change that is never built looks shipped from
// every angle a test can see. Had the launcher's own gate not existed, the run would have used a
// binary without the fix and I would have drawn conclusions from a pipeline that was not running
// my changes.
//
// The launcher's comment records the same thing happening before: "Live 2026-08-09: tool-usage
// logging was wired, unit-tested and reported working, and the run emitted nothing — dist had been
// built eighteen hours earlier. Nine passing tests, zero events."
//
// AND THAT GATE COVERS ONE LAUNCHER OF EIGHT. tier3-metrolinx-run.sh has it; the other seven can
// start on a stale binary with nothing said. So the check moves into a shared library that the
// desk-side pre-flight calls now, and every launcher can call — one implementation, not eight.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/build-freshness.sh');
const PREFLIGHT = join(ROOT, 'orchestrations/scripts/preflight-static.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A repo-shaped fixture: src/ and dist/, with controllable mtimes. */
function fixture(distNewer: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'build-fresh-')); made.push(d);
  mkdirSync(join(d, 'src', 'tools'), { recursive: true });
  mkdirSync(join(d, 'dist'), { recursive: true });
  const src = join(d, 'src', 'tools', 'thing.ts');
  const dist = join(d, 'dist', 'epam.js');
  writeFileSync(src, 'export const a = 1;\n');
  writeFileSync(dist, '// built\n');
  const old = new Date(Date.now() - 60_000);
  const now = new Date();
  if (distNewer) { utimesSync(src, old, old); utimesSync(dist, now, now); }
  else { utimesSync(dist, old, old); utimesSync(src, now, now); }
  return d;
}

/** Run the shared check against a fixture root. */
function check(root: string): { status: number; out: string } {
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(LIB)}; build_is_current ${JSON.stringify(root)}`,
  ], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

describe('the shared check', () => {
  it('exists as a library, not an eighth copy', () => {
    expect(existsSync(LIB), 'the check lives inline in one launcher and nowhere else').toBe(true);
  });

  it('passes when the build is newer than its source', () => {
    expect(check(fixture(true)).status).toBe(0);
  });

  it('FAILS when a source file is newer than the build', () => {
    const r = check(fixture(false));
    expect(r.status, 'a stale binary would have been run').not.toBe(0);
    expect(r.out).toMatch(/thing\.ts/);
  });

  it('fails when there is no build at all', () => {
    const d = fixture(true);
    rmSync(join(d, 'dist', 'epam.js'));
    expect(check(d).status).not.toBe(0);
  });

  it('ignores test files and type declarations, which are not built', () => {
    const d = fixture(true);
    const now = new Date();
    for (const name of ['thing.test.ts', 'thing.d.ts']) {
      const p = join(d, 'src', 'tools', name);
      writeFileSync(p, '// not built\n');
      utimesSync(p, now, now);
    }
    expect(check(d).status, 'a newer test file is not a stale build').toBe(0);
  });

  it('says how to fix it rather than only that it is broken', () => {
    expect(check(fixture(false)).out).toMatch(/tsup|build/i);
  });
});

describe('the desk-side pre-flight uses it', () => {
  it('preflight-static.sh calls the shared check', () => {
    const r = spawnSync('bash', ['-c', `grep -c build_is_current ${JSON.stringify(PREFLIGHT)}`],
      { encoding: 'utf8' });
    expect(Number((r.stdout || '0').trim()), 'the pre-flight still cannot see a stale binary')
      .toBeGreaterThan(0);
  });

  it('and reports it as a named check in its output', () => {
    const r = spawnSync('bash', [PREFLIGHT, ROOT], { encoding: 'utf8', timeout: 180_000 });
    expect(r.stdout || '').toMatch(/build/i);
  });
});
