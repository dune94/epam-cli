/**
 * Root cause of a live failure (2026-07-08, scaffold phase): spec-validator
 * self-reported EVERY criterion in EVERY story as "untestable" ("Since I'm
 * unable to access the actual files... through the tools provided") yet still
 * emitted overallVerdict:"fail" and per-story verdict:"fail" — a completely
 * ungrounded conclusion (the agent had zero real evidence for it, likely
 * never actually invoked its Read tool despite having access — the SAME run's
 * SAST sentinel, wired identically via run_orch_prompt_with_tools, DID use
 * its tools successfully in parallel). fuzz-weaver and perf-sentinel already
 * have a grounding check that downgrades an ungrounded "fail" to a
 * non-blocking "warn" — spec-validator's own evaluation (_spec_failing) had
 * no equivalent check at all, so this ungrounded conclusion hard-aborted the
 * whole phase.
 *
 * Fix: _spec_failing now slices the spec-validator's raw output by story
 * boundary (each "storyId" occurrence) and only counts a story's "fail"
 * verdict toward the blocking count if at least one of ITS OWN criteria has a
 * status other than "untestable" — i.e. the agent actually verified
 * something concrete about that story, not just failed by default. A story
 * where literally every criterion is "untestable" no longer blocks the gate;
 * it's downgraded to WARN with an explicit message, matching the fuzz-weaver/
 * perf-sentinel convention (not silently swallowed as a plain PASS).
 *
 * This test extracts the REAL evaluation block (python heredoc + bash
 * if/elif/else) from the actual source, not a hand-copied duplicate, and
 * runs it for real against fixture spec-validator logs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractEvalBlock(): string {
  const start = orchSrc.indexOf('if [ $spec_exit -ne 0 ]; then');
  const end = orchSrc.indexOf('# ── Phase B: review-ranger + mutant-hunter', start);
  if (start === -1 || end === -1) throw new Error('spec-validator eval block anchors not found');
  return orchSrc.slice(start, end);
}

function runSpecEvaluation(specLogContent: string): { failed: string; failingLogs: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spec-validator-grounding-'));
  try {
    const specLog = join(dir, 'spec-validator-scaffold.log');
    writeFileSync(specLog, specLogContent);

    const evalBlock = extractEvalBlock();
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -uo pipefail
step_emit() { echo "STEP_EMIT: $*" >&2; }
error() { echo "ERROR: $*" >&2; }
warning() { echo "WARNING: $*" >&2; }
success() { echo "SUCCESS: $*" >&2; }
run_eval() {
  local _failing_logs=()
  local _log_labels=()
  local failed=0
  local spec_exit=0
  local spec_log="${specLog}"
${evalBlock}
  echo "FAILED=$failed"
  echo "FAILING_LOGS=\${_failing_logs[*]:-}"
}
run_eval
`,
    );
    chmodSync(scriptPath, 0o755);
    const output = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const failed = output.match(/FAILED=(\d+)/)?.[1] ?? '';
    const failingLogs = output.match(/FAILING_LOGS=(.*)$/m)?.[1] ?? '';
    return { failed, failingLogs, stderr: '' };
  } catch (e: any) {
    const stdout = (e.stdout ?? '').toString();
    return {
      failed: stdout.match(/FAILED=(\d+)/)?.[1] ?? '',
      failingLogs: stdout.match(/FAILING_LOGS=(.*)$/m)?.[1] ?? '',
      stderr: (e.stderr ?? '').toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSpecLog(stories: Array<{ storyId: string; verdict: string; statuses: string[] }>, overallVerdict: string): string {
  const storyBlocks = stories
    .map(
      (s) => `{
      "storyId": "${s.storyId}",
      "criteria": [${s.statuses.map((st) => `{ "status": "${st}" }`).join(', ')}],
      "verdict": "${s.verdict}"
    }`,
    )
    .join(',\n    ');
  return `{
  "agent": "spec-validator",
  "stories": [
    ${storyBlocks}
  ],
  "overallVerdict": "${overallVerdict}"
}`;
}

describe('spec-validator grounding check — REAL execution', () => {
  it('the exact live-incident shape: a failing story where EVERY criterion is untestable is downgraded to WARN, not FAIL', () => {
    const log = makeSpecLog(
      [{ storyId: 'SKY-001-impl', verdict: 'fail', statuses: ['untestable', 'untestable', 'untestable'] }],
      'fail',
    );
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });

  it('a failing story with at least one REAL (non-untestable) criterion still blocks the gate', () => {
    const log = makeSpecLog(
      [{ storyId: 'SKY-004', verdict: 'fail', statuses: ['unmet', 'untestable', 'met'] }],
      'fail',
    );
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('1');
    expect(failingLogs).toContain('spec-validator-scaffold.log');
  });

  it('mixed scenario: one ungrounded (all-untestable) failing story + one grounded failing story — only the grounded one counts', () => {
    const log = makeSpecLog(
      [
        { storyId: 'SKY-001-impl', verdict: 'fail', statuses: ['untestable', 'untestable'] },
        { storyId: 'SKY-002', verdict: 'fail', statuses: ['unmet', 'met'] },
      ],
      'fail',
    );
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('1');
    expect(failingLogs).toContain('spec-validator-scaffold.log');
  });

  it('two independently grounded failing stories both count', () => {
    const log = makeSpecLog(
      [
        { storyId: 'SKY-002', verdict: 'fail', statuses: ['unmet'] },
        { storyId: 'SKY-003', verdict: 'fail', statuses: ['unmet'] },
      ],
      'fail',
    );
    const { failed } = runSpecEvaluation(log);
    expect(failed).toBe('1'); // gate boolean check only cares about > 0, both stories still counted internally
  });

  it('a passing story (verdict != fail) is never counted regardless of its criteria statuses', () => {
    const log = makeSpecLog([{ storyId: 'SKY-001', verdict: 'pass', statuses: ['met', 'met'] }], 'pass');
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });

  it('no verdict fields at all -> treated as "no-data", warns, does not block', () => {
    const log = `{"agent": "spec-validator", "stories": [{"storyId": "SKY-001"}]}`;
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });

  it('no storyId/stories at all -> treated as "no-json", warns, does not block', () => {
    const log = `The agent produced no structured output at all.`;
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });

  it('overallVerdict:warn with no per-story fails is non-blocking', () => {
    const log = makeSpecLog([{ storyId: 'SKY-001', verdict: 'warn', statuses: ['partial'] }], 'warn');
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });

  it('malformed JSON (unescaped newlines breaking json.loads) with real per-story fail+unmet is still correctly parsed via line-level regex', () => {
    const log = `{
  "stories": [
    {
      "storyId": "SKY-004",
      "criteria": [
        { "status": "unmet",
          "evidence": "line one
line two with an unescaped newline that would break json.loads" }
      ],
      "verdict": "fail"
    }
  ],
  "overallVerdict": "fail"
}`;
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('1');
    expect(failingLogs).toContain('spec-validator-scaffold.log');
  });

  it('story slicing does not bleed criteria from one story into a neighboring story', () => {
    // Story A has only untestable criteria (should NOT count); story B (which
    // follows it) has a real unmet criterion. If slicing were buggy (e.g. not
    // bounded by the NEXT storyId), story A could incorrectly inherit story
    // B's "unmet" status and wrongly count as grounded.
    const log = makeSpecLog(
      [
        { storyId: 'SKY-001-impl', verdict: 'fail', statuses: ['untestable'] },
        { storyId: 'SKY-001-test', verdict: 'pass', statuses: ['met'] },
      ],
      'fail',
    );
    const { failed, failingLogs } = runSpecEvaluation(log);
    expect(failed).toBe('0');
    expect(failingLogs).toBe('');
  });
});

describe('spec-validator ungrounded-downgrade warning message (structural)', () => {
  it('emits an explicit warn message distinguishing this from a silent pass', () => {
    const idx = orchSrc.indexOf('overallVerdict"[[:space:]]*:[[:space:]]*"fail"\' "$spec_log"');
    expect(idx).toBeGreaterThan(-1);
    const window = orchSrc.slice(idx, idx + 400);
    expect(window).toMatch(/ungrounded findings downgraded/);
    expect(window).toMatch(/untestable/);
  });
});
