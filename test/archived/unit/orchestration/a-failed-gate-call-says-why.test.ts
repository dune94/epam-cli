/**
 * WHEN A MODEL CALL FAILS, THE REASON IS THE ONLY THING THAT MAKES THE FALLBACK JUDGEABLE.
 *
 * The AC gate ran every call under `2>/dev/null`. A timeout, a missing API key and a provider
 * refusal all arrived as the same bare "Empty response from ai-run.sh", and each one falls back to
 * a verdict the gate then carries forward. Discovery had already learned this: there the same
 * swallow produced a tidy fallback to the highest-scored repository, against the wrong codeline,
 * and the comment on that fix says stderr is captured, never discarded.
 *
 * And when the gate halts, it must not describe something it did not do. It said permission-request
 * comments had been posted to Jira and to wait for a /approve-elaboration reply. ac-gate.js has no
 * jira-client require and no comment-posting path at all — deliberately, because this pipeline
 * never writes to a client system. The message sent an operator looking for comments that do not
 * exist, waiting on an approval nothing would ever receive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GATE = join(SCRIPTS, 'lib/ac-gate.js');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'gate-says-why-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** An ai-run.sh that fails the way a real one does: a diagnosis on stderr and nothing on stdout. */
function failingAiRun(reason: string): string {
  const p = join(work, 'ai-run.sh');
  writeFileSync(p, ['#!/usr/bin/env bash', `echo ${JSON.stringify(reason)} >&2`, 'exit 1'].join('\n'));
  spawnSync('chmod', ['+x', p]);
  return p;
}

function runGate(aiRun: string) {
  const issues = join(work, 'issues.json');
  writeFileSync(issues, JSON.stringify([{
    jiraKey: 'T-1',
    title: 'Fare rounds the wrong way',
    description: 'The calculator rounds a boundary value down instead of up.',
    acceptanceCriteria: [],
  }]));
  // The gate resolves ai-run.sh beside itself, so the stub replaces it via a copied tree root.
  return spawnSync(process.execPath, [GATE, '--issues', issues, '--out', join(work, 'gate.json')], {
    encoding: 'utf8',
    env: { ...process.env, AI_RUNNER_CMD: aiRun, PATH: `${work}:${process.env.PATH}` },
  });
}

describe('a failed gate call says why', () => {
  it('captures stderr rather than discarding it', () => {
    // The structural half: not one call may run under 2>/dev/null. A single survivor is a call
    // whose failures stay anonymous.
    const src = readFileSync(GATE, 'utf8');
    const swallowing = src.split('\n')
      .filter((l) => /ai-run|AI_RUN_SH/.test(l) && /2>\/dev\/null/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    expect(swallowing,
      `a model call still discards its stderr:\n  ${swallowing.join('\n  ')}`).toEqual([]);
  });

  it('every call site writes stderr somewhere it can be read back', () => {
    const src = readFileSync(GATE, 'utf8');
    const calls = src.split('\n').filter((l) => /bash \$\{AI_RUN_SH\}/.test(l));
    expect(calls.length, 'no model call sites found — the scan is matching nothing')
      .toBeGreaterThan(0);
    for (const c of calls) {
      expect(c, `a call site does not redirect stderr to a file: ${c.trim()}`).toMatch(/2>\$\{_errFile\}/);
    }
  });

  it('reports the reason with the failure, not just that it was empty', () => {
    const r = runGate(failingAiRun('provider refused: no API key for openrouter'));
    const said = `${r.stdout}${r.stderr}`;
    expect(said,
      'the gate reported a failure without the reason, so a missing key, a timeout and a refusal '
      + 'are indistinguishable').toMatch(/no API key|stderr:/);
  });
});

describe('the halt message describes what actually happened', () => {
  const INGEST = readFileSync(join(SCRIPTS, 'ingest-jira-tickets.sh'), 'utf8');
  const shown = INGEST.split('\n').filter((l) => /^\s*warn /.test(l)).join('\n');

  it('claims nothing was posted to Jira', () => {
    expect(shown, 'the halt still tells an operator that comments were posted to Jira, which this '
      + 'pipeline has no code path to do').not.toMatch(/comments have been posted/i);
    expect(shown, 'the halt does not say the approval reply it once promised is not coming')
      .not.toMatch(/approve-elaboration/);
  });

  it('tells the operator what to actually do', () => {
    // Removing a false instruction without replacing it leaves a halt with no way out.
    expect(shown, 'the halt says what is wrong but not what would fix it')
      .toMatch(/acceptance criteria/i);
  });

  it('the gate really has no path to write to a client system', () => {
    const src = readFileSync(GATE, 'utf8');
    const body = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(body, 'the gate acquired a Jira write path').not.toMatch(/jira-client|addComment/);
  });
});
