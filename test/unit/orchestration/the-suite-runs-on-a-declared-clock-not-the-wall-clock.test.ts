/**
 * A VERIFICATION SUITE RUNS ON A CLOCK THE PROJECT DECLARES, NOT ON WHATEVER TIME IT IS.
 *
 * Live 2026-09-07, run 20260906T225844Z: a correct one-line fix failed 12 writer retries against
 * two tests it never touched. The client's suite hides service updates for the first two hours of
 * the day (Schedules/utils.ts, BUSINESS_HOURS = 2) and its jest.config.js pins TZ=UTC, so those
 * tests fail between 00:00 and 02:00 UTC and pass the other twenty-two hours. The two runs that
 * succeeded ran at 21:08 UTC; this one ran at 00:29.
 *
 * Operator: "clock cannot control our pipeline that is absurd ... wall clock being an issue is
 * simply not acceptable."
 *
 * MEASURED ON THE REAL CODELINE, whole suite, both ways:
 *     wall clock  ->  746 suites, 1 failed;  3358 passed, 2 FAILED
 *     pinned      ->  746 suites, 0 failed;  3360 passed, 0 failed
 * Pinning fixes the two and breaks nothing.
 *
 * WHERE THE KNOWLEDGE LIVES. The engine knows how to pin a Node clock; it does NOT know how any
 * runner accepts a setup file. So the project declares the template and the engine substitutes —
 * exactly the split `scopedCommand` already uses for {files}. A project that declares no clock
 * behaves precisely as it does today, which is what keeps this off the path every passing run took.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = join(__dirname, '../../../orchestrations/plugins/verification-plugin.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require(PLUGIN);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function project(testSection: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'clock-'));
  dirs.push(root);
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(join(root, '.epam', 'verification.json'),
    JSON.stringify({ test: testSection }, null, 2));
  return root;
}

describe('the declared clock', () => {
  it('GUARD: a project declaring no clock is unchanged', () => {
    // Every project that passes today declares none. This must stay byte-identical for them.
    const m = plugin.readTestManifest(project({ command: 'npm run test' }));
    expect(m.ok).toBe(true);
    expect(m.command).toBe('npm run test');
    expect(m.clockInstant ?? null, 'a clock appeared where none was declared').toBeNull();
  });

  it('reads the instant and the command template the project declares', () => {
    const m = plugin.readTestManifest(project({
      command: 'npm run test',
      clockInstant: '2026-01-15T15:00:00Z',
      clockPinnedCommand: 'npm run test -- --setupFiles={setupFile}',
    }));
    expect(m.ok).toBe(true);
    expect(m.clockInstant).toBe('2026-01-15T15:00:00Z');
    expect(m.clockPinnedCommand).toBe('npm run test -- --setupFiles={setupFile}');
  });

  it('WRITES A PIN THAT ACTUALLY FREEZES Date — the artefact, executed', () => {
    /**
     * Asserting the file exists proves nothing; a pin that does not pin is the whole defect class.
     * The file is executed in a real node process and the frozen clock is read back.
     */
    const root = project({ command: 'x' });
    const f = plugin.writeClockPin(root, '2026-01-15T15:00:00Z');
    expect(existsSync(f), 'no pin file written').toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e',
      `require(${JSON.stringify(f)}); console.log(new Date().toISOString() + '|' + Date.now());`],
      { encoding: 'utf8' }).trim();
    const [iso, now] = out.split('|');
    expect(iso, 'new Date() was not frozen').toBe('2026-01-15T15:00:00.000Z');
    expect(Number(now), 'Date.now() was not frozen')
      .toBe(new Date('2026-01-15T15:00:00Z').getTime());
  });

  it('an EXPLICIT date still works — pinning must not break date arithmetic', () => {
    // Freezing "now" while breaking `new Date(x)` would corrupt every test that builds a date.
    const root = project({ command: 'x' });
    const f = plugin.writeClockPin(root, '2026-01-15T15:00:00Z');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e',
      `require(${JSON.stringify(f)}); console.log(new Date('2020-03-04T05:06:07Z').toISOString());`],
      { encoding: 'utf8' }).trim();
    expect(out).toBe('2020-03-04T05:06:07.000Z');
  });

  it('the command is the project\'s template with {setupFile} substituted', () => {
    const root = project({
      command: 'npm run test',
      clockInstant: '2026-01-15T15:00:00Z',
      clockPinnedCommand: 'npm run test -- --setupFiles={setupFile}',
    });
    const cmd = plugin.testCommandFor(root);
    expect(cmd, 'the declared template was not used').toContain('--setupFiles=');
    expect(cmd, 'the placeholder was left unsubstituted').not.toContain('{setupFile}');
    const f = cmd.split('--setupFiles=')[1].trim();
    expect(existsSync(f), 'the command names a pin file that was never written').toBe(true);
  });

  it('AN INSTANT WITHOUT A TEMPLATE CHANGES NOTHING — no runner flag is invented', () => {
    /**
     * The engine must never guess how a runner takes a setup file. Declaring only an instant is an
     * incomplete declaration, and the honest response is today's command, unchanged.
     */
    const cmd = plugin.testCommandFor(project({
      command: 'npm run test', clockInstant: '2026-01-15T15:00:00Z',
    }));
    expect(cmd).toBe('npm run test');
  });

  it('a MALFORMED instant is refused, not silently pinned to nonsense', () => {
    const cmd = plugin.testCommandFor(project({
      command: 'npm run test',
      clockInstant: 'not-a-date',
      clockPinnedCommand: 'npm run test -- --setupFiles={setupFile}',
    }));
    expect(cmd, 'an unparseable instant produced a pinned command anyway').toBe('npm run test');
  });
});

describe('the engine actually asks for the pinned command', () => {
  /**
   * WIRING, EXECUTED — because the linter cannot see this break.
   *
   * The first version of this wiring put JS comments containing an apostrophe inside claude.sh's
   * single-quoted `node -e '...'` block, and later `typeof x === 'function'`. Both silently
   * terminated the bash string, so the node program was malformed and _project_test_command
   * returned NOTHING — the suite would have run with no command at all. shellcheck passed and
   * preflight-static passed; only running the function showed it.
   */
  const { execFileSync } = require('node:child_process');
  const { readFileSync: rf, writeFileSync: wf, mkdtempSync: mk } = require('node:fs');

  function projectTestCommand(projectRoot: string): string {
    const src = rf(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
    const start = src.indexOf('_project_test_command() {');
    const end = src.indexOf('\n}\n', start) + 3;
    expect(start, '_project_test_command not found in claude.sh').toBeGreaterThan(0);
    const dir = mk(join(tmpdir(), 'ptc-'));
    dirs.push(dir);
    const fn = join(dir, 'fn.sh');
    wf(fn, src.slice(start, end));
    const drive = join(dir, 'drive.sh');
    wf(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
      `. ${JSON.stringify(fn)}`,
      `_project_test_command ${JSON.stringify(projectRoot)}`].join('\n'));
    try {
      return execFileSync('bash', [drive], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env,
               AUTOMATION_DIR: join(__dirname, '../../../orchestrations'),
               NODE_BIN: process.execPath },
      }).trim();
    } catch (e: any) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); }
  }

  it('returns the PINNED command for a project that declares a clock', () => {
    const root = project({
      command: 'npm run test',
      clockInstant: '2026-01-15T15:00:00Z',
      clockPinnedCommand: 'npm run test -- --setupFiles={setupFile}',
    });
    const cmd = projectTestCommand(root);
    expect(cmd, 'the engine resolved NO command at all — the node program is malformed')
      .not.toBe('');
    expect(cmd).toContain('--setupFiles=');
    expect(cmd).not.toContain('{setupFile}');
  });

  it('returns the plain command, unchanged, for a project that declares none', () => {
    expect(projectTestCommand(project({ command: 'npm run test' }))).toBe('npm run test');
  });
});
