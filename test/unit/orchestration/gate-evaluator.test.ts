/**
 * Testing gate evaluator tests — verifies the shell logic that reads QA gate
 * agent output and decides pass/fail/warn.
 *
 * The gate evaluator in run-agent-orchestration.sh uses python3 to extract
 * JSON from log files, then checks blockerCount / verdict fields. These tests
 * exercise the same logic inline to catch regressions without a full pipeline run.
 *
 * Pattern: write mock gate output to a temp file, run the python3 extractor
 * snippet, assert the extracted value matches expectation.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { templateBody } from '../../helpers/prompt-text';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function evalGateOutput(logContent: string): { blockers: number | string; verdict: string | null } {
  const tmp = join(tmpdir(), `gate-test-${Date.now()}.log`);
  writeFileSync(tmp, logContent, 'utf8');

  // Mirrors the python3 snippet in run_testing_gates() for SAST blockerCount
  const blockersResult = spawnSync('python3', ['-c', `
import sys, json, re
try:
    text = open('${tmp}').read()
    m = re.search(r'\\{.*\\}', text, re.DOTALL)
    if m:
        d = json.loads(m.group(0))
        print(d.get('summary', {}).get('blockerCount', -1))
    else:
        print(-1)
except Exception:
    print(-1)
`], { encoding: 'utf8' });

  // Mirrors the grep-based verdict check used for mutant-hunter / review-ranger
  const verdictResult = spawnSync('grep', ['-o', '"verdict"[[:space:]]*:[[:space:]]*"[^"]*"', tmp], {
    encoding: 'utf8',
    shell: false,
  });
  const verdictMatch = verdictResult.stdout.match(/"verdict"\s*:\s*"([^"]+)"/);

  unlinkSync(tmp);

  return {
    blockers: parseInt((blockersResult.stdout ?? '-1').trim(), 10),
    verdict: verdictMatch ? verdictMatch[1] : null,
  };
}

describe('gate evaluator — SAST blockerCount extraction', () => {
  it('extracts blockerCount=0 from valid pass output → gate passes', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel',
      phase: 'scaffold',
      summary: { filesScanned: 3, findingsCount: 0, blockerCount: 0 },
      findings: [],
      verdict: 'pass',
    });
    const { blockers } = evalGateOutput(log);
    expect(blockers).toBe(0);
  });

  it('extracts blockerCount=2 from fail output → gate fails', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel',
      phase: 'scaffold',
      summary: { filesScanned: 3, findingsCount: 2, blockerCount: 2 },
      findings: [{ severity: 'blocker', rule: 'command-injection', file: 'src/server.ts', line: 42, description: 'test', suggestedFix: '' }],
      verdict: 'fail',
    });
    const { blockers } = evalGateOutput(log);
    expect(blockers).toBe(2);
  });

  it('returns -1 when log has no parseable JSON (tool-call markup) → evaluator treats as no findings', () => {
    // This is the M3 broken output that was causing false failures before the fix
    const log = `I'll perform the SAST analysis.\n<tool_call>\n{"name":"bash","input":{"command":"ls"}}\n</tool_call>`;
    const { blockers } = evalGateOutput(log);
    expect(blockers).toBe(-1);
  });

  it('returns -1 when log is empty → evaluator treats as no findings', () => {
    const { blockers } = evalGateOutput('');
    expect(blockers).toBe(-1);
  });
});

describe('gate evaluator — verdict grep (mutant-hunter / review-ranger)', () => {
  it('detects "verdict":"fail" → gate fails', () => {
    const log = JSON.stringify({
      agent: 'mutant-hunter',
      summary: { mutationsProposed: 5, killed: 2, survived: 3, noCoverage: 0, mutationScore: 40 },
      verdict: 'fail',
    });
    const { verdict } = evalGateOutput(log);
    expect(verdict).toBe('fail');
  });

  it('detects "verdict":"pass" → gate passes', () => {
    const log = JSON.stringify({ agent: 'mutant-hunter', summary: { mutationScore: 85 }, verdict: 'pass' });
    const { verdict } = evalGateOutput(log);
    expect(verdict).toBe('pass');
  });

  it('detects "verdict":"warn" → non-blocking warning', () => {
    const log = JSON.stringify({
      agent: 'mutant-hunter',
      summary: { mutationsProposed: 0, killed: 0, survived: 0, noCoverage: 0, mutationScore: 100 },
      verdict: 'warn',
    });
    const { verdict } = evalGateOutput(log);
    expect(verdict).toBe('warn');
  });

  it('returns null verdict for M3 refusal text (no JSON) → no false fail', () => {
    // M3 produces markdown refusal — must NOT trigger "verdict:fail" grep
    const log = `I cannot fabricate a mutation-testing report without access to the actual codebase.\n## Why I cannot execute this task`;
    const { verdict } = evalGateOutput(log);
    expect(verdict).toBeNull();
  });

  it('skeleton JSON with "verdict":"fail" IS caught — this is the actual failure mode we fixed', () => {
    // M3 produced a skeleton example with verdict:fail — grep caught it and aborted run 43
    const log = `I cannot execute this task. Here is a skeleton:\n` + JSON.stringify({
      agent: 'mutant-hunter',
      summary: { mutationsProposed: 0, killed: 0, survived: 0, noCoverage: 0, mutationScore: 0 },
      verdict: 'fail',
    });
    const { verdict } = evalGateOutput(log);
    // This correctly shows the OLD behavior — the skeleton triggers a fail grep
    // The NEW fix is in the prompt: "output warn not fail when insufficient evidence"
    expect(verdict).toBe('fail');
  });
});

describe('gate evaluator — every sentinel is handed its oracle', () => {
  // These used to grep run-agent-orchestration.sh for the wording, from a hardcoded absolute
  // cwd. Since the gate prompts moved into the template layer the script no longer contains
  // any of it, and the grep counted zero for every gate at once — which reads as "all four
  // oracles are gone" when nothing about the gates changed.
  //
  // Asserting per template is also stricter than the grep ever was: a hit anywhere in a
  // 6000-line script satisfied "the SAST prompt contains X", including a hit inside a
  // different gate's prompt. Now each gate is checked against its own text.
  const cases: Array<[string, string, RegExp]> = [
    ['sast-sentinel',  'qa-sast-sentinel',  /TypeScript Compiler Results/],
    ['review-ranger',  'qa-review-ranger',  /Git Diff Evidence/],
    ['mutant-hunter',  'qa-mutant-hunter',  /Source and Test Evidence/],
  ];

  for (const [gate, tpl, oracle] of cases) {
    it(`${gate} is given its evidence, not asked to go find it`, () => {
      expect(templateBody(tpl), `${gate} judges with no oracle in front of it`).toMatch(oracle);
    });
  }

  it('no evidence-fed gate is also told it may call tools', () => {
    // The oracle and the tool ban are one design: evidence is precomputed BECAUSE the gate
    // cannot run anything. A gate that kept the oracle and lost the ban burns its turns
    // trying to shell out, which is the max-iteration exhaustion this pair prevents.
    for (const [gate, tpl] of cases.map(([g, t]) => [g, t] as const)) {
      expect(templateBody(tpl), `${gate} is not told to answer from the evidence alone`)
        .toMatch(/Do NOT attempt to call any shell commands|Do NOT call any tools/);
    }
  });

  it('mutant-hunter warns rather than blocks on insufficient evidence', () => {
    expect(templateBody('qa-mutant-hunter')).toMatch(/warn/);
    expect(templateBody('qa-mutant-hunter')).toMatch(/non-blocking/);
  });
});
