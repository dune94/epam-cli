/**
 * ai-run.sh — a call that produced NOTHING must not report success, and a
 * provider error message must survive.
 *
 * Two gaps found by audit (2026-07-25):
 *
 * 1. EMPTY EXITS 0. The result extraction ends `return $_jq_rc`; jq succeeds with
 *    empty output when the reply carries no result at all, so ai-run.sh exited 0
 *    with nothing on stdout. No fallback provider was tried, and the caller could
 *    not distinguish it from a successful call. This is the exact shape of the
 *    reviewer's 169-byte non-verdict that blocked four runs: truncated mid-think,
 *    no result, reported as success.
 *
 * 2. THE ERROR TEXT WAS DISCARDED. The inner invocation had `2>/dev/null`, so the
 *    CLI's stderr — where an API exception surfaces — was gone before the outer
 *    err_file capture. Langfuse had the message; the run log did not, and
 *    retryable_failure was classifying against empty text.
 *
 * CRITICAL DISTINCTION, and why this is not simply "empty means failure":
 * file-writing agents legitimately return an empty result STRING because their
 * work went to disk. A prior bug came from conflating the two. So:
 *   a result record exists, text empty  -> success (the agent wrote files)
 *   no result record at all             -> failure (the call produced nothing)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AI_RUN = join(__dirname, '../../../orchestrations/scripts/ai-run.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Stand in for the `epam` CLI: emits the given stdout/stderr and exit code. */
function stubCli(stdout: string, { stderr = '', code = 0 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'airun-cli-')); dirs.push(d);
  const p = join(d, 'epam');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\n` +
    (stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2\n` : '') +
    (stdout ? `cat <<'OUT'\n${stdout}\nOUT\n` : '') +
    `exit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

function runAiRun(cli: string) {
  try {
    const out = execFileSync('bash', [AI_RUN, '--provider', 'openrouter', '--model', 'z-ai/glm-5.2'], {
      encoding: 'utf8', input: 'do the thing', timeout: 30000,
      env: { ...process.env, EPAM_CLI: cli },
    });
    return { out, err: '', code: 0 };
  } catch (e: any) {
    return { out: e.stdout || '', err: e.stderr || '', code: e.status ?? 1 };
  }
}

describe('ai-run.sh — nothing produced is not success', () => {
  it('fails when the provider returned NO result record at all', () => {
    // Exit 0, plausible-looking JSON, but no result anywhere — a truncated reply.
    const { code } = runAiRun(stubCli('{"type":"log","message":"thinking..."}'));
    expect(code,
      'a call that produced nothing exited 0 — indistinguishable from success, and ' +
      'no fallback provider is tried').not.toBe(0);
  });

  it('SUCCEEDS when a result record exists but its text is empty', () => {
    // File-writing agents legitimately return empty text; their work is on disk.
    const { code } = runAiRun(stubCli('{"result":"","usage":{"input_tokens":10}}'));
    expect(code,
      'an agent that wrote files was treated as a failure — the old empty-result bug').toBe(0);
  });

  it('succeeds and prints the text for a normal reply', () => {
    const { out, code } = runAiRun(stubCli('{"result":"the verdict is approved"}'));
    expect(code).toBe(0);
    expect(out).toMatch(/the verdict is approved/);
  });
});

describe('ai-run.sh — the provider error text survives', () => {
  it('surfaces the CLI stderr instead of discarding it', () => {
    const { err, code } = runAiRun(
      stubCli('', { stderr: 'AnthropicError: 529 overloaded_error', code: 1 }));
    expect(code).not.toBe(0);
    expect(err,
      'the API error message was discarded by 2>/dev/null — the run log cannot say WHY it failed')
      .toMatch(/529|overloaded_error/);
  });
});
