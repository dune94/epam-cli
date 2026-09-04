/**
 * healing-events.jsonl MUST EXIST (even empty) after a reset — not merely be "cleared if present".
 *
 * pre-run-reset.sh's CLEARABLE_LOGS loop only truncates a file that ALREADY EXISTS
 * (`[ -f "$fp" ] && [ -s "$fp" ]`). On a genuinely fresh install/project that has never had a
 * self-heal event, healing-events.jsonl has never been created at all — so after the reset it
 * stays ABSENT, not empty.
 *
 * That distinction is invisible to a human reading "healing-events.jsonl is empty/absent — clean
 * slate for this run" (preflight-check.sh's own message treats them as equivalent), but it is NOT
 * invisible to nginx: agent-monitor serves LOG_DIR at /logs-dir, and a request for a path that does
 * not exist on disk gets a 404, not an empty 200. preflight-check.sh's own next check —
 * `curl -sf ${_DASH}/logs/healing-events.jsonl` — treats that 404 as a hard FAILURE and refuses to
 * launch.
 *
 * Confirmed live 2026-09-04, pipeline-tests-9's first-ever clean run after both the subnet/port fix
 * and the run-state-dirs fix: this was the FIRST time the pipeline had ever cleanly reached this
 * exact point on a genuinely fresh install (no prior self-heal history) — every earlier run had
 * failed at an earlier gate, which is exactly why this gap went unnoticed until now.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESET = join(__dirname, '../../../orchestrations/scripts/pre-run-reset.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runReset(opts: { withStaleHealingLog?: boolean } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'prr-healing-'));
  dirs.push(logDir);
  const prdDir = mkdtempSync(join(tmpdir(), 'prr-healing-prd-'));
  dirs.push(prdDir);
  const prd = join(prdDir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [] }));
  if (opts.withStaleHealingLog) {
    writeFileSync(join(logDir, 'healing-events.jsonl'), '{"stale":"from a previous run"}\n');
  }
  let out = '', code = 0;
  try {
    out = execFileSync('bash', [RESET, '--prd', prd, '--log-dir', logDir], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_SKIP_CONTAINER_RESTART: '1' },
    });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  return { out, code, logDir };
}

describe('pre-run-reset.sh guarantees healing-events.jsonl EXISTS after every reset', () => {
  it('a genuinely fresh LOG_DIR (healing-events.jsonl never created) ends up with an empty FILE, not absence', () => {
    const { logDir, code, out } = runReset({});
    expect(code, `pre-run-reset.sh failed:\n${out}`).toBe(0);
    expect(existsSync(join(logDir, 'healing-events.jsonl')),
      'healing-events.jsonl is still absent after the reset — nginx will 404 it and preflight will refuse to launch')
      .toBe(true);
    expect(readFileSync(join(logDir, 'healing-events.jsonl'), 'utf8')).toBe('');
  });

  it('a STALE healing-events.jsonl from a prior run is still truncated, not left with old content', () => {
    const { logDir, code } = runReset({ withStaleHealingLog: true });
    expect(code).toBe(0);
    expect(readFileSync(join(logDir, 'healing-events.jsonl'), 'utf8'),
      'a prior run\'s self-heal events leaked into this run').toBe('');
  });

  it('every OTHER declared clearable log also ends up existing (empty), not just healing-events.jsonl', () => {
    // Same guarantee, by pattern rather than by name — a file added to CLEARABLE_LOGS tomorrow is
    // covered without anyone remembering this test exists.
    const { logDir, code } = runReset({});
    expect(code).toBe(0);
    for (const f of ['agent-activity.jsonl', 'phase-cost.jsonl', 'story-failures.jsonl']) {
      expect(existsSync(join(logDir, f)), `${f} does not exist after a fresh reset`).toBe(true);
    }
  });
});
