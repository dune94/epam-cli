/**
 * run_retry_extension_coordinator() — stdout contamination bug (found live,
 * 2026-07-13, tier3-travel-app run, story SKY-003).
 *
 * Root cause: the function's return value (the number of extra retries
 * granted) is captured by its caller in implement_story() via bash command
 * substitution: `_granted_extra_retries=$(run_retry_extension_coordinator
 * "$story_id")`. Command substitution captures EVERYTHING the function
 * writes to stdout. This function's own internal `log "..."` calls ALSO
 * write to stdout (log()'s real definition, claude.sh:563 — no `>&2`) — so
 * every diagnostic log line inside the function got mixed into the captured
 * "number of retries granted" value, corrupting it into a multi-line,
 * non-numeric string.
 *
 * Live symptom: retry-extension-decisions.jsonl correctly recorded
 * {"extend":true,"extraRetriesGranted":2,...} for SKY-003 (written via a
 * direct `jq -n -c ... >> file`, unaffected by the stdout capture), but the
 * story was STILL marked "Failed to implement SKY-003 after 8 attempts"
 * immediately afterward, with zero further retries — the caller's
 * `[ "$_granted_extra_retries" -gt 0 ]` numeric check silently failed
 * against the corrupted, multi-line capture and fell through to the
 * existing "give up" path instead of extending.
 *
 * Why the PRE-EXISTING retry-extension-coordinator.test.ts never caught
 * this: its own test harness stubs `log()`/`warning()` with a SAFE
 * stderr-only version (`log() { echo "LOG: $*" >&2; }`) instead of using
 * claude.sh's REAL stdout-writing definition — so it verified the
 * function's decision LOGIC correctly, but never exercised the actual
 * integration behavior that broke live. This file uses the REAL log()
 * definition, extracted from claude.sh itself, specifically to close that
 * gap.
 *
 * Fix: both internal `log` calls now redirect to stderr (`>&2`), so the
 * function's stdout contains ONLY the final `echo "$granted"` — nothing
 * else can ever contaminate the caller's captured value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('run_retry_extension_coordinator() — static: internal log() calls redirect to stderr', () => {
  const fnBody = extractFunctionBody('run_retry_extension_coordinator');

  it('both internal log() calls are redirected to stderr (>&2), not left on stdout', () => {
    const logCalls = [...fnBody.matchAll(/log\s+"[^"]*\[RetryExtension\][^"]*"(\s*>&2)?/g)];
    expect(logCalls.length).toBeGreaterThanOrEqual(2);
    for (const m of logCalls) {
      expect(m[1], `log call "${m[0].slice(0, 60)}..." must redirect to stderr`).toBe(' >&2');
    }
  });
});

describe('run_retry_extension_coordinator() — REAL integration: the exact caller-side capture pattern from implement_story()', () => {
  // Uses the REAL log()/warning() definitions from claude.sh (not a safe
  // stderr-only stub) to reproduce the exact integration bug.
  function run(opts: { gateResponse: string; repeatedDiagnosis?: boolean }): {
    granted: number;
    capturedRaw: string;
    callerWouldExtend: boolean;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'retry-ext-log-contam-'));
    try {
      writeFileSync(
        join(dir, 'healing-events.jsonl'),
        opts.repeatedDiagnosis
          ? [
              JSON.stringify({ ts: 't1', story_id: 'SKY-003', retry: 0, target: 'skill', diagnosis: 'same bug' }),
              JSON.stringify({ ts: 't2', story_id: 'SKY-003', retry: 1, target: 'skill', diagnosis: 'same bug' }),
            ].join('\n') + '\n'
          : [
              JSON.stringify({ ts: 't1', story_id: 'SKY-003', retry: 0, target: 'skill', diagnosis: 'bug A' }),
              JSON.stringify({ ts: 't2', story_id: 'SKY-003', retry: 1, target: 'skill', diagnosis: 'bug B' }),
            ].join('\n') + '\n',
      );
      writeFileSync(
        join(dir, 'failure-diagnosis-groundedness.jsonl'),
        [
          JSON.stringify({ storyId: 'SKY-003', diagnosis: 'bug A', skipped: false, score: 0.87 }),
          JSON.stringify({ storyId: 'SKY-003', diagnosis: 'bug B', skipped: false, score: 0.57 }),
        ].join('\n') + '\n',
      );

      const scriptDir = join(dir, 'scripts');
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(
        join(scriptDir, 'ai-run.sh'),
        `#!/usr/bin/env bash\ncat >/dev/null\necho ${JSON.stringify(opts.gateResponse)}\n`,
        { mode: 0o755 },
      );

      const profilesDir = join(dir, 'agents');
      mkdirSync(profilesDir, { recursive: true });
      writeFileSync(join(profilesDir, 'profiles.json'), JSON.stringify({ 'retry-extension-coordinator': 'test profile' }));

      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-003', acceptanceCriteria: Array(27).fill('AC') }] }));

      const logFnBody = extractFunctionBody('log');
      const evidenceFnBody = extractFunctionBody('compute_retry_extension_evidence');
      const coordFnBody = extractFunctionBody('run_retry_extension_coordinator');

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `OUTPUT_DIR=${JSON.stringify(dir)}`,
          `LOG_DIR=${JSON.stringify(dir)}`,
          `PROGRESS_LOG=${JSON.stringify(join(dir, 'progress.txt'))}`,
          `SCRIPT_DIR=${JSON.stringify(scriptDir)}`,
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
          'EPAM_CLI=epam',
          'EPAM_RETRY_EXTENSION_ENABLED=1',
          'ORCH_GATE_PROVIDER=openrouter',
          'ORCH_GATE_MODEL=test-model',
          // Minimal color vars log() references -- absence would just print
          // literal empty strings, not a functional difference for this test.
          'BLUE=""; NC=""',
          logFnBody, // the REAL log(), writes to stdout -- NOT stubbed
          evidenceFnBody,
          coordFnBody,
          // Exact caller-side pattern from implement_story() (claude.sh, the
          // "Retry-extension coordinator" block right after the inner retry
          // loop's own `done`):
          '_granted_extra_retries=$(run_retry_extension_coordinator "SKY-003")',
          'echo "CAPTURED_RAW_START"',
          'echo "$_granted_extra_retries"',
          'echo "CAPTURED_RAW_END"',
          'if [ -n "$_granted_extra_retries" ] && [ "$_granted_extra_retries" -gt 0 ] 2>/dev/null; then',
          '  echo "CALLER_WOULD_EXTEND=true"',
          'else',
          '  echo "CALLER_WOULD_EXTEND=false"',
          'fi',
        ].join('\n'),
      );

      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const capturedRaw = stdout.split('CAPTURED_RAW_START\n')[1]?.split('\nCAPTURED_RAW_END')[0] ?? '';
      const callerWouldExtend = /CALLER_WOULD_EXTEND=true/.test(stdout);
      const granted = parseInt(capturedRaw.trim().split('\n').pop() ?? '-1', 10);
      return { granted, capturedRaw, callerWouldExtend };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: a genuinely granted extension (extend:true) is captured as a CLEAN "2", and the caller\'s numeric check now correctly decides to extend', () => {
    const { capturedRaw, callerWouldExtend } = run({
      gateResponse: '{"extend":true,"extraRetries":2,"reason":"consistently grounded, distinct progress"}',
    });
    // The captured value must be EXACTLY the number, no log text mixed in --
    // this is what was broken live (capturedRaw contained the "[RetryExtension]
    // ... extending by 2 ..." log line ahead of the plain "2").
    expect(capturedRaw.trim()).toBe('2');
    expect(callerWouldExtend).toBe(true);
  });

  it('a gate decline (extend:false) is also captured cleanly as "0", with no log contamination', () => {
    const { capturedRaw, callerWouldExtend } = run({
      gateResponse: '{"extend":false,"extraRetries":0,"reason":"low confidence"}',
    });
    expect(capturedRaw.trim()).toBe('0');
    expect(callerWouldExtend).toBe(false);
  });

  it('the OTHER contaminated log call site (deterministic pre-gate, non-convergence) is also captured cleanly as "0"', () => {
    // Exercises claude.sh:4942's log call specifically (the pre-gate path,
    // which skips the LLM call entirely) -- a repeated diagnosis fires this
    // branch, not the gate-response branch the other two tests exercise.
    const { capturedRaw, callerWouldExtend } = run({
      gateResponse: '{"extend":false,"extraRetries":0,"reason":"should not be called"}',
      repeatedDiagnosis: true,
    });
    expect(capturedRaw.trim()).toBe('0');
    expect(callerWouldExtend).toBe(false);
  });
});
