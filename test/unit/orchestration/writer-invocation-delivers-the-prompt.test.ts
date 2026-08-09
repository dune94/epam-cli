/**
 * THE PROMPT MUST REACH THE PROCESS — a delivery test, not a unit test.
 *
 * Live 2026-08-09, all 8 writer attempts:
 *
 *     Error: no prompt provided via stdin
 *     Cost[AMSD-2041] in=0 out=0 cost=$0
 *
 * The prompt was built correctly, 1,008 lines, logged every attempt. A comment placed inside the
 * invocation's line-continuation chain terminated the command, so `echo "$prompt" | ENV=...` ran
 * as a pipeline with no consumer and the real invocation got nothing on stdin. `bash -n` accepts
 * it — it is valid shell, just not the command that was written.
 *
 * WHY THIS FILE EXISTS AT ALL. Four failures in one day share one shape, and it is not
 * carelessness about any single line:
 *
 *     read dedupe        tested execute() directly   shipped a notice no model could act on
 *     plugin version     tested the plugin's logic   shipped a plugin that never loaded
 *     line continuation  tested the helper function  shipped an invocation with empty stdin
 *     stale dist         tested src/                 shipped a binary built 18 hours earlier
 *
 * Every one tested the UNIT and not the DELIVERY. A unit test cannot see a broken pipeline, an
 * unloaded plugin, or a stale artefact, because in a unit test the caller is the test itself —
 * which always calls correctly, always loads the module, and always uses the source.
 *
 * So this runs the SHIPPED invocation block with a stub standing in for the epam binary, and
 * asserts what that stub received. It fails on the exact defect that cost 8 attempts, and it
 * would fail again for any future edit that severs the command from its input.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * Lifts the writer invocation verbatim — from `if echo "$prompt" | \` through the redirection
 * that ends it — and runs it against a stub binary that records its stdin.
 */
function invokeWriter(prompt: string) {
  const start = SRC.indexOf('if echo "$prompt" | \\');
  expect(start, 'the writer invocation was not found — this test is pinned to stale text').toBeGreaterThan(-1);
  const endMark = '> "$raw_file" 2>> "$output_file"; then';
  const end = SRC.indexOf(endMark, start);
  expect(end, 'the invocation terminator moved').toBeGreaterThan(start);
  // Close the `if` so the fragment is runnable on its own.
  const block = SRC.slice(start, end + endMark.length) + '\n  :\nfi\n';

  const dir = mkdtempSync(join(tmpdir(), 'writerinv-')); dirs.push(dir);
  const stub = join(dir, 'epam-stub');
  const received = join(dir, 'received.txt');
  // The stub IS the assertion surface: whatever the shell actually delivers lands here.
  writeFileSync(stub, `#!/usr/bin/env bash\ncat > ${JSON.stringify(received)}\nexit 0\n`);
  chmodSync(stub, 0o755);

  execFileSync('bash', ['-c',
    `set +e
     prompt=${JSON.stringify(prompt)}
     raw_file=${JSON.stringify(join(dir, 'raw.json'))}
     output_file=${JSON.stringify(join(dir, 'out.log'))}
     json_result_file=${JSON.stringify(join(dir, 'res.json'))}
     _epam_run_binary=${JSON.stringify(stub)}
     _timeout_prefix=()
     epam_model_flag=()
     STORY_PROVIDER=stub
     story_id=S1 LOG_DIR=${JSON.stringify(dir)} PROJECT_ROOT=${JSON.stringify(dir)}
     _story_agent_role=probe _req_symbols="" _req_scope="" _allowed_write_paths=""
     _effective_max_iterations=1 _effective_compress_at="" _effective_compress_every_n=""
     STORY_MAX_OUTPUT_TOKENS=1024 EPAM_STORY_MAX_TOOL_CALLS="" _tool_policy_redirect=""
     _epam_sandbox_target="" OPENROUTER_API_KEY="" EPAM_API_KEY_OPENROUTER=""
     normalize_provider_json() { :; }
${block}`,
  ], { encoding: 'utf8' });

  return existsSync(received) ? readFileSync(received, 'utf8') : '';
}

describe('the writer invocation delivers its prompt', () => {
  it('the process receives the prompt on stdin', () => {
    const got = invokeWriter('IMPLEMENT THE STORY');
    expect(
      got,
      'the invocation ran with empty stdin — this is the defect that burned 8 attempts at $0 ' +
      'while bash -n reported the script was fine',
    ).toContain('IMPLEMENT THE STORY');
  });

  it('a multi-line prompt arrives intact', () => {
    // The real prompt is ~1,000 lines; a single-line fixture would not notice truncation.
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    const got = invokeWriter(body);
    expect(got).toContain('line 1');
    expect(got, 'the prompt was truncated in transit').toContain('line 200');
  });

  it('content that could confuse a shell survives', () => {
    // Prompts carry code, quotes and backslashes; delivery must not depend on their absence.
    const tricky = 'const x = "quoted"; // $HOME `cmd` \\ end-of-prompt-marker';
    expect(invokeWriter(tricky)).toContain('end-of-prompt-marker');
  });

  it('nothing was silently dropped — the stub really ran', () => {
    // Guards against a vacuous pass: an empty received file with a passing toContain would be
    // impossible, but a stub that never executed would leave no file at all.
    expect(invokeWriter('marker').length).toBeGreaterThan(0);
  });
});
