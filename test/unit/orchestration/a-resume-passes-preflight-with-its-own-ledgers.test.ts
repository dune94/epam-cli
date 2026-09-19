/**
 * PRE-FLIGHT DOES NOT REFUSE A RESUME FOR CARRYING ITS OWN LEDGERS.
 *
 * pre-run-reset.sh now keeps a resumed run's ledgers (phase gates, cost, healing events) — they
 * are the run's own record, and clearing them re-ran a finished phase. Pre-flight's check 6b then
 * refused the very next resume: "healing-events.jsonl is non-empty from a prior run — run
 * pre-run-reset.sh to clear it". Found by the £0 paused rehearsal, 2026-09-19, on the resume
 * launched after completion. Pre-flight already knows a resume for the PRD ("the PRD is the
 * run's own working copy"); the same holds for the ledgers.
 *
 * Runs the real 6b block, lifted from preflight-check.sh, both ways.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PREFLIGHT = join(__dirname, '../../../orchestrations/scripts/preflight-check.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function healingBlock(): string {
  const src = readFileSync(PREFLIGHT, 'utf8');
  const start = src.indexOf('# 6b. healing-events.jsonl');
  const end = src.indexOf('# 6c.', start);
  if (start < 0 || end < 0) throw new Error('6b block not found in preflight-check.sh');
  return src.slice(start, end);
}

function run(env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'preflight-ledger-')); dirs.push(d);
  writeFileSync(join(d, 'healing-events.jsonl'), '{"story":"REGI-001-tests","retry":1}\n');
  const r = spawnSync('bash', ['-c', [
    'FAILS=0; ok(){ echo "OK: $*"; }; fail(){ echo "FAIL: $*"; FAILS=$((FAILS+1)); }',
    `LOG_DIR_DEFAULT=${JSON.stringify(d)}`,
    healingBlock(),
    'exit $FAILS',
  ].join('\n')], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('pre-flight check 6b — healing-events.jsonl', () => {
  it('accepts a non-empty ledger on a resume: it is this run\'s own record', () => {
    const r = run({ EPAM_RESUME_RUN: '20260918T132928Z' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/OK:.*resum/i);
  });

  it('still refuses a non-empty ledger on a fresh launch', () => {
    const r = run({ EPAM_RESUME_RUN: '' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/FAIL:.*non-empty/);
  });
});
