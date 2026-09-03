/**
 * THE PRECONDITION A PAID LAUNCHER NOW HAS: a coverage measurement that passes.
 *
 * tier3-*.sh gate the whole coverage map before they spend, so any test that EXECUTES one has to
 * satisfy that gate or the launcher exits before doing the thing under test. These tests are not
 * about coverage — they are about launcher behaviour — so they supply the precondition the same way
 * they supply a PRD or a project directory.
 *
 * NOT A BYPASS. It builds a real, passing coverage report over a real stage map: the gate runs in
 * full and passes on the evidence given. A test that wanted to prove the gate BLOCKS supplies
 * failing data instead — see every-stage-asks-the-coverage-gate.test.ts.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const REPO = resolve(__dirname, '../..');

/** Every file the real stage map counts, so the fixture covers exactly what the gate measures. */
function inScope(): string[] {
  const cfg = JSON.parse(
    readFileSync(join(REPO, 'orchestrations/config/stage-coverage.json'), 'utf8'));
  const skip = new RegExp(cfg.excludePattern);
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = join(d, e.name);
      if (skip.test(f)) continue;
      if (e.isDirectory()) walk(f);
      else if (cfg.extensions.some((x: string) => f.endsWith(x))) out.push(f);
    }
  };
  for (const r of cfg.roots) walk(resolve(REPO, r));
  return out;
}

/**
 * Env that makes the coverage gate PASS: every in-scope file fully covered, in a report newer than
 * the tree it describes.
 */
export function gatedRunEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'gated-'));
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  const lines: string[] = [];
  for (const f of inScope()) {
    let n = 0;
    try { n = readFileSync(f, 'utf8').split('\n').length; } catch { continue; }
    lines.push(`SF:${relative(REPO, f)}`);
    for (let i = 1; i <= n; i += 1) lines.push(`DA:${i},1`);
    lines.push(`LF:${n}`, `LH:${n}`, 'end_of_record');
  }
  const lcov = join(dir, 'coverage/lcov.info');
  writeFileSync(lcov, `${lines.join('\n')}\n`);
  // The freshness check compares against every in-scope file's mtime, so the fixture must be newer
  // than all of them or the gate refuses on staleness rather than on coverage.
  const newest = inScope().reduce((max, f) => {
    try { return Math.max(max, statSync(f).mtimeMs); } catch { return max; }
  }, 0);
  const future = new Date(newest + 60_000);
  const fs = require('node:fs');
  fs.utimesSync(lcov, future, future);

  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ thresholdPercent: 95, blocker: true }));
  return {
    STAGE_COVERAGE_LCOV: lcov,
    STAGE_COVERAGE_LCOV_SHELL: lcov,
    STAGE_COVERAGE_REPORT: join(dir, 'coverage/stage-coverage.json'),
    STAGE_COVERAGE_POLICY: join(dir, 'policy.json'),
  };
}
