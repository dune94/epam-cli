/**
 * The pre-run resets must happen even when the PRD file does not exist yet.
 *
 * pre-run-reset.sh does the standing pre-run work: archive logs, clear the KB
 * scratchpad, reset cost, and point the dashboard at this run's PRD. Line 65 was
 *     [ -f "$PRD_FILE" ] && success ... || fail "PRD not found: $PRD_FILE"
 * so a missing PRD aborted the WHOLE script before any of that ran.
 *
 * That became reachable on 2026-07-25 when PRD paths went per-project: metrolinx's
 * PRD is now orchestrations/projects/metrolinx/prd.json, which the JIRA INGEST
 * CREATES — and pre-run-reset runs BEFORE the ingest. tier3-metrolinx-run.sh:170
 * wraps the call in `|| info "... non-fatal, continuing"`, so the run would proceed
 * with cost NOT reset, KB scratchpad NOT cleared and logs NOT archived — silently
 * violating every standing pre-run requirement at once.
 *
 * Correct behaviour: the resets do not depend on the PRD existing. Warn, skip only
 * the dashboard mount, and still do the work.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESET = join(__dirname, '../../../orchestrations/scripts/pre-run-reset.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runReset(prdPath: string) {
  const logDir = mkdtempSync(join(tmpdir(), 'prr-logs-'));
  dirs.push(logDir);
  mkdirSync(join(logDir, 'kb-scratchpad'), { recursive: true });
  writeFileSync(join(logDir, 'kb-scratchpad', 'stale.md'), 'stale note from a failed attempt');
  writeFileSync(join(logDir, 'old-run.log'), 'previous run output');
  let out = '', code = 0;
  try {
    out = execFileSync('bash', [RESET, '--prd', prdPath, '--log-dir', logDir],
      { encoding: 'utf8', env: { ...process.env } });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  return { out, code, logDir };
}

describe('pre-run-reset with a PRD that does not exist yet', () => {
  it('still clears the KB scratchpad (stale notes must not leak into the run)', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'prr-prd-')), 'prd.json');
    dirs.push(missing);
    const { logDir } = runReset(missing);
    expect(existsSync(join(logDir, 'kb-scratchpad', 'stale.md')),
      'stale KB scratchpad survived the reset').toBe(false);
  });

  it('still archives the previous run logs', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'prr-prd-')), 'prd.json');
    dirs.push(missing);
    const { logDir } = runReset(missing);
    expect(existsSync(join(logDir, 'old-run.log')),
      'previous run log was left in place — errors will point at the wrong run').toBe(false);
  });

  it('warns that the dashboard mount was skipped rather than dying silently', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'prr-prd-')), 'prd.json');
    dirs.push(missing);
    const { out } = runReset(missing);
    expect(out).toMatch(/PRD not found|not yet created|skipping dashboard/i);
  });

  it('still works normally when the PRD does exist', () => {
    const d = mkdtempSync(join(tmpdir(), 'prr-prd-')); dirs.push(d);
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [] }));
    const { logDir } = runReset(prd);
    expect(existsSync(join(logDir, 'kb-scratchpad', 'stale.md'))).toBe(false);
  });
});
