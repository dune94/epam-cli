/**
 * The most expensive call in the pipeline fails silently and then retries.
 *
 * mock1 run 10, measured:
 *
 *   pre-phase assessment   2 calls   25 + 25 turns   586,478 tokens   $0.2163
 *   whole run                                                         $0.3807
 *
 * 57% of the run. Its entire output was 58 bytes:
 *
 *   Agent reached maximum iterations (25) without completing.
 *
 * The prompt is a seven-part task — jq per story, assign roles, create missing
 * profiles, infer pitfalls against six worked examples, gap-check, write a
 * markdown summary. It is not slow, it is unfinishable in 25 turns, so the agent
 * explores to the cap and returns nothing. `pre-assessment-core.log` shows the
 * same exhaustion in three archived runs.
 *
 * TWO independent fail-opens hid it:
 *
 *  1. `run_orch_prompt_with_tools ... | tee "$log" || _pfa_call_ok=0` — the
 *     script sets `set -e` but never `set -o pipefail`, so the pipeline's exit
 *     status is tee's, which is always 0. The `||` branch cannot fire on an
 *     agent failure.
 *  2. Nothing inspects the output. AgentRunner returns the exhaustion notice as
 *     a NORMAL result with exit 0. claude.sh, spec-mode-runner.js and
 *     brownfield-repro-test-writer.sh all detect that exact string as a
 *     capability failure. This call site did not.
 *
 * So it burned 57% of the run, produced nothing, reported success, and the
 * pipeline carried on without the profile augmentation it believes it has.
 *
 * Retrying is the wrong response and this is the second time today: a corrective
 * note tells an agent it misbehaved, but exhaustion means the TASK did not fit.
 * The same prompt at the same cap exhausts again — two attempts did exactly that
 * in run 10 — so a capability failure is reported and NOT retried.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fn(name: string): string {
  const re = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`${name}() not found`);
  const start = m.index;
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

/** Run the real detector against a log body. */
function detects(logBody: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'pfa-cap-'));
  dirs.push(dir);
  const log = join(dir, 'pre-assessment-core.log');
  writeFileSync(log, logBody);

  const drive = join(dir, 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash',
    fn('_pfa_capability_failed'),
    `if _pfa_capability_failed ${JSON.stringify(log)}; then echo YES; else echo NO; fi`,
  ].join('\n'));

  const r = spawnSync('bash', [drive], { encoding: 'utf8', timeout: 20000 });
  return /YES/.test(r.stdout || '');
}

describe('an exhausted agent is recognised as a failure', () => {
  it('detects the exact message AgentRunner emits', () => {
    expect(detects('Agent reached maximum iterations (25) without completing.\n'),
      'the pipeline treats an agent that produced nothing as a successful assessment')
      .toBe(true);
  });

  it('detects it regardless of the cap in the message', () => {
    // The cap is configurable, so the number must not be part of the match.
    expect(detects('Agent reached maximum iterations (10) without completing.')).toBe(true);
  });

  it('detects it when the notice is buried in other output', () => {
    expect(detects('some tool output\nmore output\nAgent reached maximum iterations (25) without completing.\n')).toBe(true);
  });

  it('does not fire on a real assessment', () => {
    expect(detects('Assessed 2 stories. Added 3 skill rules to typescript-engineer.\n'),
      'a successful assessment is discarded as a failure')
      .toBe(false);
  });

  it('does not fire on an empty log', () => {
    // Empty is its own failure mode, handled by the exit-status check — this
    // detector must not claim it, or the two diagnoses become indistinguishable.
    expect(detects('')).toBe(false);
  });
});

describe('the failure reaches the caller', () => {
  it('reads the real exit status instead of tee\'s', () => {
    const body = fn('run_pre_phase_assessment');
    expect(body,
      'the agent call is piped into tee, so its exit status is discarded and a ' +
      'failed assessment reports success')
      .toMatch(/PIPESTATUS/);
  });

  it('does not retry an exhausted agent with the same prompt', () => {
    const body = fn('run_pre_phase_assessment');
    const i = body.indexOf('_pfa_capability_failed');
    expect(i, 'the capability check is not wired into the retry loop').toBeGreaterThan(-1);
    expect(body.slice(i, i + 700),
      'an exhausted agent is retried against the identical prompt — the same task ' +
      'at the same cap exhausts again, at full cost')
      .toMatch(/break/);
  });

  it('says so loudly rather than logging and continuing', () => {
    const body = fn('run_pre_phase_assessment');
    const i = body.indexOf('_pfa_capability_failed');
    expect(body.slice(i, i + 700), 'the failure is not surfaced to the operator')
      .toMatch(/error |warning /);
  });
});
