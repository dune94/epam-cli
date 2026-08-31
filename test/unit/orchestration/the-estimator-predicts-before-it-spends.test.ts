/**
 * THE COST FORECAST — 485 lines with no test.
 *
 * estimate-stories.sh predicts minutes, cost, tokens and turns per story BEFORE a run spends
 * anything. It is the number the operator decides on, and every one of its failure modes is quiet:
 * a story silently skipped costs nothing to predict and everything to discover later, and an
 * estimate produced from a PRD it could not read is a confident answer about nothing.
 *
 * Run end to end against a PRD fixture, because the artifact is the forecast it emits.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/estimate-stories.sh');

/** A PRD in the shape the estimator reads: stories PLUS the phase index it walks. */
function prdWith(stories: any[]) {
  const order: Record<string, string[]> = {};
  for (const st of stories) {
    const p = st.phase || 'core';
    (order[p] = order[p] || []).push(st.id);
  }
  return { stories, implementationOrder: order, project: { name: 'p' } };
}

function estimate(prd: unknown, args: string[] = ['--json'], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'estimate-'));
  const f = join(dir, 'prd.json');
  writeFileSync(f, typeof prd === 'string' ? prd : JSON.stringify(prd));
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      PRD_FILE: f,
      NODE_BIN: process.execPath,
      // The coverage gate stands down outside a gated run; make that explicit rather than relying
      // on ambient state, so this test measures the estimator and not the gate.
      EPAM_COVERAGE_GATED: '0',
      ...env,
    },
  });
  let json: any = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* table mode, or a refusal */ }
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '', json, prdPath: f };
}

const story = (over: Record<string, unknown> = {}) => ({
  id: 'S-1', title: 'A story', effort: 'medium', storyType: 'feature',
  acceptanceCriteria: ['one', 'two'], phase: 'core', ...over,
});

describe('the estimator predicts before anything is spent', () => {
  it('produces a forecast for every story, not a subset', () => {
    // A silently skipped story costs nothing to predict and everything to discover later.
    const r = estimate(prdWith([story(), story({ id: 'S-2' }), story({ id: 'S-3' })]));
    expect(r.code, r.err).toBe(0);
    expect(r.json, 'no JSON forecast was produced').toBeTruthy();
    const ids = JSON.stringify(r.json);
    for (const id of ['S-1', 'S-2', 'S-3']) {
      expect(ids, `${id} has no forecast, and nothing said so`).toContain(id);
    }
  }, 180_000);

  it('every forecast carries all four metrics — a missing one is an unanswerable question', () => {
    const r = estimate(prdWith([story()]));
    const body = JSON.stringify(r.json);
    for (const metric of ['minutes', 'cost', 'tokens', 'turns']) {
      expect(body.toLowerCase(), `the forecast omits ${metric}`).toContain(metric);
    }
  }, 180_000);

  it('a HIGHER effort forecasts more than a lower one — the model discriminates', () => {
    // Without this every assertion above holds on a model that returns one constant.
    const low = estimate(prdWith([story({ id: 'L', humanHours: 1 })]));
    const high = estimate(prdWith([story({ id: 'H', humanHours: 20 })]));
    const cost = (j: any) => Number((/"estimatedCost"\s*:\s*([0-9.]+)/.exec(JSON.stringify(j)) || [])[1]);
    expect(cost(high.json), 'a 20-hour story forecasts no more than a 1-hour one')
      .toBeGreaterThan(cost(low.json));
  }, 180_000);

  it("a story's DECLARED effort is believed when it carries no hours", () => {
    // This read humanHours alone, so a story carrying effort:"high" and no hours fell to 0 hours and
    // scored the LOW tier. Brownfield tickets routinely carry an effort label and no hours at all.
    const r = estimate(prdWith([story({ id: 'S-1', effort: 'high' })]));
    expect(JSON.stringify(r.json), "the story's declared effort was overridden by an absent hours field")
      .toMatch(/"effort"\s*:\s*"high"/);
  }, 180_000);

  it('A ZERO FORECAST IS NAMED, because it is an unknown story and not a free one', () => {
    // The cost model multiplies by hours, so a story with none forecasts zero minutes, zero tokens
    // and zero cost. The row prints, the totals add up, and the operator approves a run whose cost
    // was never estimated. No number is invented — the story is named and the total is declared an
    // underestimate.
    const r = estimate(prdWith([story({ id: 'S-1', effort: 'high' })]));
    expect(r.err, 'a story with no hours forecast zero and said nothing about it')
      .toMatch(/S-1[\s\S]*UNDERESTIMATE|UNDERESTIMATE[\s\S]*S-1/);
  }, 180_000);

  it('and a story WITH hours produces no such warning', () => {
    // The negative half: a warning on every story would be noise nobody reads.
    const r = estimate(prdWith([story({ id: 'S-1', humanHours: 8 })]));
    expect(r.err, 'a fully-estimated story was reported as an underestimate')
      .not.toMatch(/UNDERESTIMATE/);
  }, 180_000);

  it('is a DRY RUN by default — it does not rewrite the PRD it was asked about', () => {
    const prd = prdWith([story()]);
    const r = estimate(prd);
    const after = JSON.parse(readFileSync(r.prdPath, 'utf8'));
    expect(after, 'the estimator wrote to the PRD without being asked to').toEqual(prd);
  }, 180_000);

  it('--phase scopes the forecast, and a phase with no stories is not an error', () => {
    const body = prdWith([story({ id: 'A', phase: 'core' }), story({ id: 'B', phase: 'later' })]);
    const core = estimate(body, ['--json', '--phase', 'core']);
    expect(JSON.stringify(core.json)).toContain('A');
    expect(JSON.stringify(core.json), 'a story outside the requested phase was forecast')
      .not.toContain('"B"');
    // An unknown phase is REFUSED, not silently forecast as empty: a mis-typed scope would
    // otherwise report a run costing nothing.
    const unknown = estimate(body, ['--json', '--phase', 'no-such-phase']);
    expect(unknown.code, 'a mis-typed phase was accepted and forecast as empty').not.toBe(0);
    expect(unknown.out + unknown.err, 'the refusal does not say which phases exist')
      .toMatch(/core|later|Available phases/);
  }, 180_000);

  it('a MISSING PRD is refused, not forecast as zero', () => {
    // A confident zero is the worst possible answer here: it says the run is free.
    const r = spawnSync('bash', [SCRIPT, '--json'], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PRD_FILE: '/no/such/prd.json', EPAM_COVERAGE_GATED: '0' },
    });
    expect(r.status, 'a missing PRD produced a forecast').not.toBe(0);
  }, 180_000);

  it('an UNPARSEABLE PRD is refused for the same reason', () => {
    const r = estimate('{ not json');
    expect(r.code, 'a broken PRD produced a forecast').not.toBe(0);
  }, 180_000);

  it('a PRD with no stories forecasts nothing, and says so rather than printing an empty table', () => {
    const r = estimate(prdWith([]));
    expect(r.out + r.err, 'an empty PRD produced no statement at all').not.toBe('');
  }, 180_000);

  it('--help explains itself and exits cleanly', () => {
    const r = estimate(prdWith([story()]), ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--apply|--phase|--json/);
  }, 180_000);

  it('an unknown flag is refused rather than silently ignored', () => {
    // Silently ignoring it means the operator believes they scoped a forecast that was never scoped.
    const r = estimate(prdWith([story()]), ['--not-a-flag']);
    expect(r.code, 'an unknown flag was accepted, so a mis-typed scope would pass unnoticed')
      .not.toBe(0);
  }, 180_000);
});
