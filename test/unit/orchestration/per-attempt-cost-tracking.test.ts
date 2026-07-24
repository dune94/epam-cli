/**
 * append_cost_record()'s per-attempt tracking — REAL execution of the
 * actual, unmodified function extracted by marker.
 *
 * Built 2026-07-23 after discovering phase-cost.jsonl only ever recorded the
 * FINAL attempt of a multi-retry story (append_cost_record was called
 * exactly twice per story: once on terminal success, once on terminal
 * failure). An 8-attempt AMSD-1820 failure with ~200-240k real input tokens
 * on EVERY attempt would have shown only the last one in any dashboard or
 * report — hiding roughly 7/8 of the real, billed cost. Fixed by calling
 * append_cost_record after EVERY attempt (status="attempt", attempt number
 * set), in addition to the existing terminal calls.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

function extractFn(name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`function not found: ${name}`);
  let depth = 0, i = start, bodyStart = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') { if (bodyStart === -1) bodyStart = i; depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const appendCostRecordFn = extractFn('append_cost_record');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cost-tracking-'));
  cleanupDirs.push(dir);
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify({
    stories: [{ id: 'AMSD-1820', title: 'Test story', agentRole: 'typescript-engineer', effort: 'medium', storyType: 'implementation' }],
    implementationOrder: { core: ['AMSD-1820'] },
  }));
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify({ total_cost_usd: 0.0607, usage: { input_tokens: 238391, output_tokens: 1742 } }));
  const costFile = join(dir, 'phase-cost.jsonl');
  return { dir, prdPath, resultPath, costFile };
}

function callAppendCostRecord(args: { status: string; attemptNum?: string; prdPath: string; resultPath: string; costFile: string; dir: string }): any[] {
  const script = `
error() { :; }
warning() { :; }
log() { :; }
emit_story_artifact() { :; }
LOG_DIR='${args.dir}'
${appendCostRecordFn}
MAIN_PRD_FILE='${args.prdPath}'
PHASE_COST_FILE='${args.costFile}'
append_cost_record "AMSD-1820" "${args.status}" "2026-07-23T13:00:00Z" "2026-07-23T13:05:00Z" "/tmp/fake.log" "${args.resultPath}" ${args.attemptNum ? `"${args.attemptNum}"` : ''}
`;
  execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return readFileSync(args.costFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('append_cost_record — per-attempt token tracking (real extracted code)', () => {
  it('records an "attempt" status row with the real token/cost usage and attempt number', () => {
    const { dir, prdPath, resultPath, costFile } = makeFixture();
    const records = callAppendCostRecord({ status: 'attempt', attemptNum: '3', prdPath, resultPath, costFile, dir });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('attempt');
    expect(records[0].attempt).toBe(3);
    expect(records[0].task_tokens_in).toBe(238391);
    expect(records[0].task_tokens_out).toBe(1742);
    expect(records[0].task_cost_usd).toBe(0.0607);
  });

  it('terminal calls (no attempt number) still record attempt:null, backward compatible', () => {
    const { dir, prdPath, resultPath, costFile } = makeFixture();
    const records = callAppendCostRecord({ status: 'failed', prdPath, resultPath, costFile, dir });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].attempt).toBeNull();
  });

  it('multiple attempts accumulate as separate rows — the actual fix: every attempt visible, not just the last', () => {
    const { dir, prdPath, resultPath, costFile } = makeFixture();
    callAppendCostRecord({ status: 'attempt', attemptNum: '1', prdPath, resultPath, costFile, dir });
    callAppendCostRecord({ status: 'attempt', attemptNum: '2', prdPath, resultPath, costFile, dir });
    callAppendCostRecord({ status: 'attempt', attemptNum: '3', prdPath, resultPath, costFile, dir });
    callAppendCostRecord({ status: 'failed', prdPath, resultPath, costFile, dir });
    const records = readFileSync(costFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records).toHaveLength(4);
    const attemptRows = records.filter((r) => r.status === 'attempt');
    expect(attemptRows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    const totalTokensAcrossAllAttempts = attemptRows.reduce((sum, r) => sum + r.task_tokens_in, 0);
    expect(totalTokensAcrossAllAttempts).toBe(238391 * 3); // previously this real cost was entirely invisible
  });
});
