/**
 * REPLAY NEVER REACHED THE WRITER, SO REHEARSAL HAS NEVER WORKED.
 *
 * lib/llm-handler.sh owns replay and states its own premise:
 *
 *   "Every model call in the pipeline, from bash and from JS alike, execs THIS script, so the
 *    substitution belongs here and nowhere else."
 *
 * False. claude.sh carries a SECOND provider dispatch inside implement_story —
 * `case "$STORY_PROVIDER"` with arms invoking "$CLAUDE_CMD" --print, codemie-claude --print and
 * the epam runner DIRECTLY. The writer never execs ai-run.sh, so it never reaches llm-handler.
 *
 * Measured 2026-09-09: a rehearsal with EPAM_REPLAY_CASSETTE_DIR correctly set in the process
 * reported `provider=claude` on every attempt, printed "REHEARSAL: replaying" ZERO times, and
 * climbed to opus-5 across five failing attempts. The cassette was never opened — which is why
 * cassettes could not prove anything, after two days of work on them.
 *
 * The fix DELEGATES rather than reimplements: a second copy of the substitution would be the same
 * defect one level up. When a recording is in play the call is handed to ai-run.sh, which execs
 * llm-handler.sh, which owns replay.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/replay-delegate.sh');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A stand-in for ai-run.sh that records it was reached and what it was given. */
function stubRunner(dir: string) {
  const f = join(dir, 'ai-run.sh');
  writeFileSync(f, `#!/usr/bin/env bash
cat > "${join(dir, 'stdin.txt')}"
printf '%s\\n' "$*" > "${join(dir, 'argv.txt')}"
printf '%s' "\${ORCH_JSON_RESULT:-}" > "${join(dir, 'jsonout.txt')}"
echo '{"result":"from the cassette"}' > "\${ORCH_JSON_RESULT:-/dev/null}"
echo replayed
`);
  chmodSync(f, 0o755);
  return f;
}

/**
 * Everything lives in ONE temp dir: the stub writes its evidence beside the script that ran it.
 * My first version created the stub in a different directory and read argv.txt from the other —
 * so a working delegation looked like a failure.
 */
function call(opts: { recording: boolean; runnerMissing?: boolean }) {
  const d = tmp('repdel-');
  const json = join(d, 'result.json');
  const log = join(d, 'out.log');
  const runner = opts.runnerMissing ? join(d, 'does-not-exist.sh') : stubRunner(d);
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
source "${LIB}"
export AI_RUNNER_CMD="${runner}"
if replay_delegate "the prompt" "${json}" "${log}" "claude-haiku-4-5-20251001"; then
  echo "HANDLED"
else
  echo "NOT_HANDLED"
fi
`);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, EPAM_REPLAY_CASSETTE_DIR: opts.recording ? d : '' },
  });
  const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), dir: d,
           log: read(log), argv: read(join(d, 'argv.txt')), stdin: read(join(d, 'stdin.txt')),
           json: read(json), jsonOut: read(join(d, 'jsonout.txt')) };
}

describe('replay_delegate', () => {
  it('does NOTHING when no recording is in play — the normal path is untouched', () => {
    const r = call({ recording: false });
    expect(r.out).toMatch(/NOT_HANDLED/);
    expect(r.argv, 'it called the runner on an ordinary paid run').toBe('');
  });

  it('HANDS THE CALL to ai-run.sh when a recording is in play', () => {
    const r = call({ recording: true });
    expect(r.out).toMatch(/HANDLED/);
    expect(r.argv, 'the runner was never reached — replay would not engage').toMatch(/--model claude-haiku/);
    expect(r.stdin, 'the prompt did not reach the runner').toContain('the prompt');
  });

  it('routes the result where the caller expects it, so the reply is usable', () => {
    const r = call({ recording: true });
    expect(r.jsonOut, 'ORCH_JSON_RESULT was not passed through').toMatch(/result\.json$/);
    expect(r.json, 'the replayed reply was not written where the caller reads it')
      .toContain('from the cassette');
  });

  it('REFUSES rather than falling through to a paid provider when the runner is missing', () => {
    const r = call({ recording: true, runnerMissing: true });
    expect(r.out, 'it fell through — a rehearsal would have reached a paid provider')
      .toMatch(/HANDLED/);
    expect(r.log).toMatch(/REFUSING/);
  });
});

describe("claude.sh's second dispatch", () => {
  const src = () => readFileSync(CLAUDE_SH, 'utf8');

  it('DELEGATES before it dispatches — an unreached guard is this same defect again', () => {
    const lines = src().split('\n');
    const guard = lines.findIndex((l) => l.includes('if replay_delegate "$prompt"'));
    const dispatch = lines.findIndex((l) => l.trim() === 'case "$STORY_PROVIDER" in');
    expect(guard, 'claude.sh does not call replay_delegate — the writer bypasses replay again')
      .toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(guard, 'the guard runs AFTER the dispatch, so the CLI is invoked first')
      .toBeLessThan(dispatch);
  });

  it('still sources the library it depends on', () => {
    expect(src(), 'replay-delegate.sh is never sourced, so the guard is an unbound command')
      .toMatch(/source "\$SCRIPT_DIR\/lib\/replay-delegate\.sh"/);
  });
});
