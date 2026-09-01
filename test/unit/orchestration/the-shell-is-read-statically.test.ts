/**
 * EVERY SHELL FILE READ BY AN ANALYSER — THE HALF OF THE PROBLEM THAT NEEDS NO TESTS.
 *
 * The engine is mostly bash and most of it has no test behind it. Coverage measures how much a test
 * has EXECUTED; this measures how much is wrong on its face, across 100% of the files, in about a
 * second, with nothing written first. bats cannot do that — it runs tests you author, so it carries
 * the same authoring cost as the debt it would pay down.
 *
 * The classes gated here have each already cost this project a run:
 *
 *   SC2155  `export VAR="$(cmd)"` takes export's status, always 0, masking the command's — the
 *           defect tier3-mock-run.sh documents in a comment, found by hand, one instance at a time
 *   SC2015  `A && B || C` is not if-then-else; this is `cmd || true` followed by a read of $?
 *   SC2188  a redirection with no command — an orphaned `<<<` fragment of this exact shape left a
 *           41-assertion suite unparseable, so it had never run at all
 *   SC2031  a variable modified in a subshell, where the change is lost
 *
 * IT MUST FAIL CLOSED. A scanner that reports nothing because it could not run is indistinguishable
 * from a clean sheet, and that silence is the shape of every defect it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const SCANNER = join(REPO, 'orchestrations/scripts/lib/handlers/scan-shell-defects.js');
const PREFLIGHT = join(REPO, 'orchestrations/scripts/preflight-static.sh');
const BASELINES = join(REPO, 'orchestrations/config/preflight-baselines.json');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

function scan(root: string, env: Record<string, string> = {}) {
  const r = spawnSync(NODE20, [SCANNER, root], {
    encoding: 'utf8', timeout: 240000, cwd: REPO,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

// ONE SCAN, REUSED. Each assertion re-scanning 141 files cost ~30s and made a seven-test suite
// take three and a half minutes to say the same thing. The scan is deterministic; run it once.
const FULL = scan(REPO);
const LINES = FULL.out.split('\n').filter(Boolean);

describe('the shell is read statically', () => {
  it('reports findings across the engine, in a form naming file, line and rule', () => {
    expect(FULL.status, `the scanner failed:\n${FULL.err.slice(0, 300)}`).toBe(0);
    const lines = LINES;
    expect(lines.length, 'no findings at all — a silent scanner is the defect, not a clean sheet')
      .toBeGreaterThan(0);
    for (const l of lines.slice(0, 20)) {
      expect(l, `unreadable finding: ${l}`).toMatch(/^\S+:\d+:\d+ SC\d+ \w+ .+/);
    }
  }, 260_000);

  it('reports only warning and above — info noise would bury the classes that matter', () => {
    // SC1091 ("not following" a sourced file) and SC2016 (single quotes in jq programs) are both
    // correct here and outnumber the real findings three to one. A ratchet nobody reads is not one.
    const levels = new Set(LINES.map((l) => /SC\d+ (\w+)/.exec(l)?.[1]));
    expect([...levels].sort()).not.toContain('info');
    expect([...levels].sort()).not.toContain('style');
  }, 260_000);

  it('FAILS CLOSED when shellcheck is not available', () => {
    // An empty PATH makes the binary unfindable. Reporting zero findings here would read as a pass.
    const r = scan(REPO, { PATH: mkdtempSync(join(tmpdir(), 'empty-path-')) });
    expect(r.status, 'a missing analyser produced a clean sheet').not.toBe(0);
    expect(r.err).toMatch(/shellcheck/i);
  }, 260_000);

  it('FAILS CLOSED when there is nothing to scan, rather than passing vacuously', () => {
    const r = scan(mkdtempSync(join(tmpdir(), 'no-shell-')));
    expect(r.status, 'an empty tree scanned clean').not.toBe(0);
    expect(r.err).toMatch(/no shell files/i);
  }, 260_000);

  it('survives a reader that closes early, so `| head` shows findings not a stack trace', () => {
    const r = spawnSync('bash', ['-c',
      `${JSON.stringify(NODE20)} ${JSON.stringify(SCANNER)} ${JSON.stringify(REPO)} 2>&1 | head -3`],
      { encoding: 'utf8', timeout: 240000, cwd: REPO });
    expect(r.stdout || '', 'an EPIPE stack trace buries the finding it was printed for')
      .not.toMatch(/EPIPE|Unhandled 'error'/);
  }, 260_000);

  it('PRE-FLIGHT RUNS IT — a scanner nothing calls changes nothing', () => {
    const pre = readFileSync(PREFLIGHT, 'utf8');
    expect(pre, 'preflight does not ratchet the shell defects')
      .toMatch(/ratchet "shell defects" "shellDefects" "scan-shell-defects\.js"/);
    const base = JSON.parse(readFileSync(BASELINES, 'utf8'));
    expect(typeof base.shellDefects, 'no baseline for shellDefects — the ratchet cannot run')
      .toBe('number');
    expect(existsSync(SCANNER)).toBe(true);
  });

  it('and the baseline matches what the scanner reports today', () => {
    // The ratchet fails on any count ABOVE baseline. A baseline seeded wrong is either a gate that
    // never fires or one that fails on day one.
    const n = LINES.length;
    const base = JSON.parse(readFileSync(BASELINES, 'utf8')).shellDefects;
    expect(n, `scanner reports ${n}, baseline says ${base}`).toBeLessThanOrEqual(base);
  }, 260_000);
});
