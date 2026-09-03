/**
 * THE COST FORECAST UPDATER — 141 lines, no test.
 *
 * It reads historical actuals and suggests forecasts for stories that have none. Two things make it
 * worth covering: it WRITES to the PRD under --apply, and a forecast derived from no history is a
 * number presented with the same confidence as one derived from a hundred runs.
 *
 * It also hardcoded its PRD path, unlike estimate-stories.sh beside it, so it could only ever act on
 * one file and could not be exercised without writing to the real one. That is now overridable —
 * a script that rewrites a PRD and cannot be pointed at a copy is a script nobody can test safely.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/update-cost-forecasts.sh');

function forecasts(prd: unknown, costLog: string | null, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'forecast-'));
  const f = join(dir, 'prd.json');
  writeFileSync(f, typeof prd === 'string' ? prd : JSON.stringify(prd));
  const log = join(dir, 'phase-cost.jsonl');
  if (costLog !== null) writeFileSync(log, costLog);
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PRD_FILE: f, PHASE_COST_FILE: log, EPAM_COVERAGE_GATED: '0' },
  });
  let after: any = null;
  try { after = JSON.parse(readFileSync(f, 'utf8')); } catch { /* left alone */ }
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, after, prdPath: f };
}

const prd = (stories: any[]) => ({ stories, implementationOrder: { core: stories.map((s) => s.id) },
  project: { name: 'p' } });

const actual = (id: string, cost: number) => JSON.stringify({
  storyId: id, status: 'completed', cost, tokens: 100000, durationMs: 60000 });

describe('cost forecasts are suggested, not imposed', () => {
  it('is a DRY RUN by default — it does not rewrite the PRD it was asked about', () => {
    const body = prd([{ id: 'S-1', title: 't' }]);
    const r = forecasts(body, `${actual('S-0', 3.5)}\n`);
    expect(r.after, 'the forecaster rewrote the PRD without being asked to').toEqual(body);
  }, 180_000);

  it('--apply is what writes, or the suggestion is computed and thrown away', () => {
    const body = prd([{ id: 'S-1', title: 't' }]);
    const r = forecasts(body, `${actual('S-0', 3.5)}\n${actual('S-2', 4.0)}\n`, ['--apply']);
    expect(r.code, r.out.slice(0, 400)).toBe(0);
    // Either it wrote a forecast, or it explained why it could not — never silence.
    const changed = JSON.stringify(r.after) !== JSON.stringify(body);
    expect(changed || /no |cannot|insufficient|nothing/i.test(r.out),
      '--apply neither wrote a forecast nor said why not').toBe(true);
  }, 180_000);

  it('NO history is stated rather than answered with a confident number', () => {
    // A forecast derived from nothing carries the same authority on the page as one derived from a
    // hundred runs. Saying so is the only thing that separates them.
    const r = forecasts(prd([{ id: 'S-1', title: 't' }]), '');
    expect(r.out, 'an empty history produced no statement at all').not.toBe('');
    expect(r.out, 'it invented a forecast from no data and said nothing about it')
      .toMatch(/no |empty|insufficient|nothing|cannot/i);
  }, 180_000);

  it('a MISSING cost log is handled rather than throwing', () => {
    const r = forecasts(prd([{ id: 'S-1', title: 't' }]), null);
    expect(r.out).not.toMatch(/No such file|line \d+:/);
  }, 180_000);

  it('a MISSING PRD is refused rather than creating one', () => {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PRD_FILE: '/no/such/prd.json', EPAM_COVERAGE_GATED: '0' },
    });
    expect(r.status, 'a missing PRD was treated as a PRD with no stories').not.toBe(0);
  }, 180_000);

  it('an UNPARSEABLE PRD is refused, and the file is left as it was', () => {
    const r = forecasts('{ not json', `${actual('S-0', 3.5)}\n`, ['--apply']);
    expect(r.code, 'a broken PRD was rewritten').not.toBe(0);
    expect(readFileSync(r.prdPath, 'utf8'), 'the original was destroyed by a failed rewrite')
      .toBe('{ not json');
  }, 180_000);

  it('a torn line in the cost log is skipped, not fatal', () => {
    // The log is appended to by live runs; a partially-written last line is normal.
    const r = forecasts(prd([{ id: 'S-1', title: 't' }]),
      `${actual('S-0', 3.5)}\n{"storyId":"S-9","sta`);
    expect(r.code, 'a torn last line in the cost log killed the forecaster').toBe(0);
  }, 180_000);

  it('an unknown flag is refused rather than silently ignored', () => {
    const r = forecasts(prd([{ id: 'S-1', title: 't' }]), `${actual('S-0', 3.5)}\n`, ['--not-a-flag']);
    expect(r.code, 'an unknown flag was accepted, so --aply would silently dry-run').not.toBe(0);
  }, 180_000);
});
