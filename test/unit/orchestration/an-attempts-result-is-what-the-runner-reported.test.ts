/**
 * AN ATTEMPT'S RESULT IS WHAT THE RUNNER REPORTED — HOWEVER THE ATTEMPT ENDED.
 *
 * Live 2026-09-24 (regintel REGI-009a, v2.0.68): an attempt ran 120 iterations, 11.4M input tokens,
 * stop_reason max_iterations — and the ledger recorded $0 and zero tokens, the failure class
 * "unknown". The epam-run normalizer read the raw output with `jq -s`, which rejects the WHOLE
 * stream on one line that is not JSON; `|| true` then left the result file EMPTY. It also rebuilt
 * the result from scratch, dropping stop_reason, iterations, toolCallCount, model, provider and
 * cost_is_estimate, so nothing downstream could tell an exhausted attempt from a finished one.
 * (That attempt's raw file was lost to a restart; the fixture is a real raw file from the same run.)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ATTEMPT = join(__dirname, '../../../orchestrations/scripts/lib/story-attempt.sh');
const REAL = join(__dirname, '../../fixtures/runner-output/epam-run-regi009a-20260924.raw.json');
const dirs: string[] = []; afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function normalize(raw: string) {
  const d = mkdtempSync(join(tmpdir(), 'norm-')); dirs.push(d);
  writeFileSync(join(d, 'raw.json'), raw);
  const r = spawnSync('bash', ['-c', `SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}
${shellFunction(ATTEMPT, 'normalize_provider_json')}
normalize_provider_json epam-run ${JSON.stringify(join(d, 'raw.json'))} ${JSON.stringify(join(d, 'out.json'))}`], { encoding: 'utf8' });
  const text = (() => { try { return readFileSync(join(d, 'out.json'), 'utf8'); } catch { return ''; } })();
  return { text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), err: r.stderr };
}
const real = readFileSync(REAL, 'utf8');
// The live shape: the same run's output, ended at its iteration cap.
const exhausted = real.replace(/\n\{\n  "result":/, '\n{\n  "stop_reason": "max_iterations",\n  "result":');

describe('an attempt\'s result is what the runner reported', () => {
  it('the fixture is the real run\'s output and ends with its result block', () => {
    expect(exhausted).toContain('"stop_reason": "max_iterations"');
    expect(normalize(real).json?.usage?.input_tokens).toBe(2390835);
  });

  it('ONE line that is not JSON does not cost the attempt its result', () => {
    // Among the log lines, before the result object begins — where a record cut mid-write lands.
    const at = exhausted.indexOf('\n{\n  "stop_reason"') + 1;
    expect(at, 'the result object was not found in the fixture').toBeGreaterThan(0);
    const broken = exhausted.slice(0, at) + '{"level":30,"time":1790253688702,"msg":"a log line cut off mid-wri\n' + exhausted.slice(at);
    expect(() => JSON.parse('[' + broken.split('\n').filter(Boolean).join(',') + ']'), 'the injected line must really be invalid JSON').toThrow();
    const { json, text } = normalize(broken);
    expect(text.length, 'the result file was left empty — the attempt vanished from the ledger').toBeGreaterThan(0);
    expect(json?.usage?.input_tokens).toBe(2390835);
    expect(json?.usage?.cached_input_tokens).toBe(2289186);
  });

  it('keeps what says HOW the attempt ended and what it was: stop_reason, iterations, tool calls, model, provider, estimate flag', () => {
    const { json } = normalize(exhausted);
    expect(json?.stop_reason).toBe('max_iterations');
    expect(json?.iterations).toBe(JSON.parse(real.slice(real.lastIndexOf('\n{\n') + 1)).iterations);
    expect(json?.toolCallCount).toBe(60);
    expect(json?.model).toBe('MiniMax-M3');
    expect(json?.provider).toBe('minimax');
    expect(json?.cost_is_estimate).toBe(true);
    expect(json?.total_cost_usd).toBe(0.7498);
  });

  it('a raw with no result at all says so — it is not a zero-cost success', () => {
    const { json } = normalize('{"level":30,"msg":"started"}\n{"level":30,"msg":"killed"}\n');
    expect(json?.result).toBe('');
    expect(json?.no_result_reported).toBe(true);
  });
});
