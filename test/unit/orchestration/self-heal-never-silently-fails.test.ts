/**
 * B30 — self-heal must never fail silently.
 *
 * agent-attempt-analyst.sh is the self-heal for agents that fail by producing no
 * usable output. Found 2026-07-25 by audit, before it could cost another run:
 *
 *   - Its LLM call was `bash "$AI_RUNNER_CMD" ... 2>/dev/null || echo ""`, so a
 *     failed call became an empty string with no signal.
 *   - It emitted `self_heal_complete` ("failure-analyst prescribed corrective
 *     directive") UNCONDITIONALLY, before any check that a corrective existed —
 *     so the activity feed asserted success on total failure.
 *   - It ended `exit 0` always, and both call sites added their own
 *     `2>/dev/null || echo ""` on top, discarding even its stderr.
 *
 * Net effect: when the analyst failed, every retry re-ran the IDENTICAL prompt
 * with no corrective guidance, while the log said "invoking self-heal analyst"
 * and the dashboard said "prescribed corrective directive". Indistinguishable
 * from working self-heal — you would misread the run as "the ladder didn't help"
 * when the analyst never actually ran.
 *
 * The contract is deliberately three-valued, because "no corrective" is a
 * LEGITIMATE outcome for provider/infra/timeout classes (no agent behaviour to
 * correct) and must stay distinguishable from a broken analyst:
 *   exit 0 + output    -> corrective prescribed
 *   exit 0 + no output -> deliberate skip (provider/infra/timeout)
 *   exit 2             -> the analyst itself failed; caller must record it
 *
 * Self-heal is still best-effort and still must not block the caller. Not
 * blocking is not the same as not telling anyone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ANALYST = join(__dirname, '../../../orchestrations/scripts/agent-attempt-analyst.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Stub runner standing in for ai-run.sh, with a controllable outcome. */
function stubRunner(body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'b30-'));
  dirs.push(d);
  const p = join(d, 'stub-runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function runAnalyst(runner: string, failureClass = 'max_iterations') {
  const logFile = join(mkdtempSync(join(tmpdir(), 'b30-log-')), 'agent.log');
  dirs.push(logFile);
  writeFileSync(logFile, 'agent reached maximum iterations without writing a file');
  try {
    const out = execFileSync('bash', [ANALYST, failureClass, logFile], {
      encoding: 'utf8',
      env: { ...process.env, AI_RUNNER_CMD: runner, AGENT_ANALYST_STORY_ID: 'B30-TEST' },
    });
    return { out, err: '', code: 0 };
  } catch (e: any) {
    return { out: e.stdout || '', err: e.stderr || '', code: e.status ?? 1 };
  }
}

describe('B30 — a failed self-heal analyst is detectable by its caller', () => {
  it('exits non-zero when its own model call fails', () => {
    const { code } = runAnalyst(stubRunner('echo "provider exploded" >&2; exit 1'));
    expect(code,
      'analyst swallowed a failed model call and exited 0 — the caller cannot tell ' +
      'self-heal did nothing, and retries re-run the identical prompt').not.toBe(0);
  });

  it('exits non-zero when the model returns nothing for a correctable class', () => {
    const { code } = runAnalyst(stubRunner('exit 0'));
    expect(code,
      'empty corrective for a correctable failure class reported as success').not.toBe(0);
  });

  it('still succeeds, and prints the directive, when the analyst works', () => {
    const { out, err, code } = runAnalyst(stubRunner('echo "Write the file before finishing."'));
    expect(code, `analyst exited ${code}; stderr: ${err}`).toBe(0);
    expect(out).toContain('Write the file before finishing.');
  });

  it('keeps exit 0 for provider/infra/timeout — a deliberate skip is not a failure', () => {
    for (const cls of ['provider', 'infra', 'timeout']) {
      const { code } = runAnalyst(stubRunner('exit 1'), cls);
      expect(code, `${cls} is a legitimate no-op and must not be reported as a broken analyst`).toBe(0);
    }
  });
});

describe('B30 — the activity feed must not claim a corrective that does not exist', () => {
  const src = readFileSync(ANALYST, 'utf8');

  it('does not emit self_heal_complete unconditionally', () => {
    // The bug was a bare emit on its own line, before any guard.
    expect(src,
      'self_heal_complete is emitted without checking a corrective was produced — ' +
      'the dashboard reports success on total failure')
      .not.toMatch(/^_emit_fa "self_heal_complete"/m);
  });

  it('has a distinct failure signal for the feed', () => {
    expect(src, 'no self_heal_failed event — a failed self-heal is invisible to observability')
      .toMatch(/self_heal_failed/);
  });
});

describe('B30 — call sites must not discard the analyst outcome', () => {
  const sites = [
    'orchestrations/scripts/brownfield-repro-test-writer.sh',
    'orchestrations/scripts/lib/tc-writer-gate.sh',
  ];
  for (const rel of sites) {
    it(`${rel} records that self-heal failed`, () => {
      const s = readFileSync(join(__dirname, '../../../', rel), 'utf8');
      const call = s.split('\n').findIndex(l => l.includes('agent-attempt-analyst.sh') && !l.trim().startsWith('#'));
      expect(call, 'analyst call site not found').toBeGreaterThan(-1);
      const window = s.split('\n').slice(call, call + 12).join('\n');
      expect(window,
        'the analyst exit code is never captured here, so a failed self-heal is ' +
        'indistinguishable from one that deliberately had nothing to add')
        .toMatch(/_analyst_rc|\$\?|PIPESTATUS/);
    });
  }
});
