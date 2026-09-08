/**
 * THE LEDGER SEES EVERY DOLLAR, AND CAN ATTRIBUTE IT.
 *
 * Found by reading a real run's ledger (AMSD-1919, 2026-09-08) after the run reported $14.52.
 *
 * DEFECT 1 — TWO WRITERS, TWO SHAPES. lib/cost-record.sh (the shell hub, every vendor BINARY
 * call) writes `agent_type` and NO cache fields. lib/cost-emitter.js writes `agent_name` WITH
 * cache fields. So the single largest record in the run — $6.76, 81k in / 39k out — showed
 * `agent: ?` and `cacheRead: 0`, and 62% of the spend could not be attributed to a seam or
 * explained. It was not uncached; the writer simply has no field for it.
 *
 * DEFECT 2 — THE PLAN PASS IS BILLED AND NEVER RECORDED. plan-execute is ON by default
 * (EPAM_PLAN_EXECUTE:-1): every call makes a plan invocation AND an execute invocation. The hub
 * skips recording when _EPAM_IN_PLAN_PASS=1, so the plan half is spent and invisible. A ledger
 * that under-reports is worse than one that is merely coarse: every forecast built on it is low.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REC = join(process.cwd(), 'orchestrations-installer', '..', 'orchestrations/scripts/lib/cost-record.sh');
const HANDLER = join(process.cwd(), 'orchestrations/scripts/llm-handler.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Runs the real record_call_cost against a runner result carrying cache usage. */
function record(agent = 'spec-agent') {
  const d = tmp('ledger-');
  const reply = join(d, 'result.json');
  const ledger = join(d, 'phase-cost.jsonl');
  writeFileSync(reply, JSON.stringify({
    type: 'result', total_cost_usd: 6.7579, num_turns: 12,
    usage: {
      input_tokens: 81348, output_tokens: 39054,
      cache_read_input_tokens: 240000, cache_creation_input_tokens: 15000,
    },
  }));
  const drive = join(d, 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    `export PHASE_COST_FILE=${JSON.stringify(ledger)}`,
    'export LOG_DIR=' + JSON.stringify(d),
    `. ${JSON.stringify(REC)}`,
    `record_call_cost ${JSON.stringify(reply)} ${JSON.stringify(agent)} story-1 claude-sonnet-5 2026-09-08T00:43:32+00:00`,
  ].join('\n'));
  execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 });
  const lines = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean) : [];
  return lines.map((l) => JSON.parse(l));
}

describe('the shell cost writer', () => {
  it('RECORDS CACHE TOKENS — without them the biggest call looks uncached and unexplainable', () => {
    const [rec] = record();
    expect(rec, 'no record written').toBeTruthy();
    expect(rec.cache_read_tokens, 'cache reads are dropped, so a heavily cached call reads as '
      + 'full price and nobody can explain the bill').toBe(240000);
    expect(rec.cache_create_tokens, 'cache writes are dropped').toBe(15000);
  });

  it('NAMES THE AGENT the way the rest of the ledger does', () => {
    const [rec] = record('spec-agent');
    expect(rec.agent_name, 'the shell writer uses agent_type only, so every record it writes is '
      + 'anonymous to any per-agent cost view — 62% of a real run was unattributable')
      .toBe('spec-agent');
  });

  it('keeps agent_type too, because existing consumers read it', () => {
    const [rec] = record('spec-agent');
    expect(rec.agent_type, 'an existing consumer was broken to fix the new one').toBe('spec-agent');
  });
});

describe('the plan pass', () => {
  it('IS ALREADY IN THE LEDGER — merged into the answer, not skipped', () => {
    /**
     * I MISREAD THIS ONCE AND REGRESSED IT. The recorder is gated on _EPAM_IN_PLAN_PASS, which
     * looks like the plan half is billed and invisible. It is not: _merge_plan_cost folds the
     * plan pass's cost JSON into ORCH_JSON_RESULT BEFORE the record is written, so the single
     * record carries plan + execute. Removing the gate double-counts the plan — caught by
     * every-call-records-what-it-cost.test.ts, which asserts one MERGED record per call.
     */
    const src = readFileSync(HANDLER, 'utf8');
    expect(src, 'the plan cost is no longer merged, so recording only the execute pass would '
      + 'under-report every planned seam by the cost of its plan').toMatch(/_merge_plan_cost/);
    const mergeAt = src.indexOf('_merge_plan_cost\n');
    const recordAt = src.indexOf('record_call_cost "${ORCH_JSON_RESULT');
    expect(mergeAt, 'the merge call was not found').toBeGreaterThan(-1);
    expect(recordAt, 'the record call was not found').toBeGreaterThan(-1);
    expect(mergeAt, 'the plan cost is merged AFTER the record is written, so it never reaches it')
      .toBeLessThan(recordAt);
  });

  it('is not recorded a second time under its own label', () => {
    const src = readFileSync(HANDLER, 'utf8');
    expect(src, 'the plan pass records separately as well as being merged — the plan is counted '
      + 'twice and every total is high').toMatch(/_EPAM_IN_PLAN_PASS:-0\}" != "1"/);
  });
});
