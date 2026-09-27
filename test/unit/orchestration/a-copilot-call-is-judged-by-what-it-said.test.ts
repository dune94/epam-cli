/**
 * A COPILOT CALL IS JUDGED BY WHAT IT SAID, NOT BY ITS EXIT CODE.
 *
 * The GitHub Copilot CLI exits 0 when it refuses an unknown model, refuses an unsupported reasoning
 * effort, and when the provider answers 402 (spike, 2026-09-27). A runner that trusted the exit code
 * would record each of those as a successful call with an empty answer — the pipeline's worst case,
 * a failure that looks like a result. lib/copilot-result.js reads the call's own JSONL and stderr and
 * writes the result in the shape the claude runner produces, so cost, retry and self-heal read a
 * copilot call exactly as they read a claude one; a credit failure is marked (error.class = credit)
 * so the attempt halts instead of climbing a ladder whose every rung bills the same exhausted account.
 *
 * Driven on the CLI's real output, captured from copilot 1.0.85 in the spike.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLI = join(ROOT, 'orchestrations/scripts/lib/copilot-result.js');
const F = (n: string) => join(ROOT, 'test/fixtures/copilot', n);

function judge(jsonl: string, stderr: string) {
  const d = mkdtempSync(join(tmpdir(), 'copilot-result-'));
  try {
    const out = join(d, 'result.json');
    const r = spawnSync(process.execPath, [CLI, F(jsonl), F(stderr), out], { encoding: 'utf8' });
    let json: Record<string, any> = {};
    try { json = JSON.parse(readFileSync(out, 'utf8')); } catch { /* none written */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

describe('a call that answered', () => {
  it('prints the answer, exits 0, and writes the claude result shape', () => {
    const r = judge('ok.jsonl', 'empty.stderr');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('STUB-ANSWER: hello from the stub');
    expect(r.json).toMatchObject({ type: 'result', is_error: false, result: 'STUB-ANSWER: hello from the stub', stop_reason: 'end_turn' });
    expect(r.json.usage.output_tokens).toBe(56);
    expect(r.json.premium_requests).toBe(0);
  });

  it('a reply the CLI continued past a length cut is one answer, the last message, with every turn\'s tokens', () => {
    const r = judge('length-continued.jsonl', 'empty.stderr');
    expect(r.status).toBe(0);
    expect(r.json.is_error).toBe(false);
    expect(r.json.usage.output_tokens).toBe(56 * 3);
  });
});

describe('a call that failed while exiting 0', () => {
  it('402: a failure of class credit — halt, do not climb', () => {
    const r = judge('402.jsonl', 'empty.stderr');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.json).toMatchObject({ is_error: true, error: { class: 'credit', statusCode: 402 } });
    expect(r.stderr).toMatch(/402 insufficient balance/);
  });

  it('an unsupported reasoning effort: a failure of class invocation, the CLI\'s own words kept', () => {
    const r = judge('model-unavailable.jsonl', 'effort-unsupported.stderr');
    expect(r.status).not.toBe(0);
    expect(r.json).toMatchObject({ is_error: true, error: { class: 'invocation' } });
    expect(r.json.error.message).toMatch(/does not support reasoning effort/);
  });

  it('a model the account is not served: a failure of class invocation', () => {
    const r = judge('model-unavailable.jsonl', 'model-unavailable.stderr');
    expect(r.status).not.toBe(0);
    expect(r.json).toMatchObject({ is_error: true, error: { class: 'invocation' } });
    expect(r.stderr).toMatch(/is not available/);
  });

  it('no events and no stderr at all: a failure, never an empty success', () => {
    const r = judge('model-unavailable.jsonl', 'empty.stderr');
    expect(r.status).not.toBe(0);
    expect(r.json.is_error).toBe(true);
  });
});
