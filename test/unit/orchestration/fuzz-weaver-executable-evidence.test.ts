/**
 * Fix for a live false-positive (2026-07-07, tier3 core phase): fuzz-weaver
 * claimed `parseAdults()` in server.ts "accepts zero and negative numbers as
 * valid inputs" — a real file, real function, but a FALSE claim (direct
 * testing showed '0'/'-1' are correctly rejected). The existing ground-truth
 * check only verified the FILE exists, which is necessary but not sufficient
 * — it can't catch a model that misreads a real file's actual behavior.
 *
 * Fix: each "vulnerability" case must now include an "executableTest" field
 * (a real vitest test the agent wrote, asserting the SAFE/expected behavior
 * for the specific input it claims is mishandled). The gate ACTUALLY RUNS
 * that test against the real code. If the assertion fails, the code really
 * doesn't behave safely — the vulnerability is confirmed for real, not on
 * the model's say-so. If it passes, the code was already correct and the
 * claim gets downgraded as unverified/hallucinated, same treatment as the
 * pre-existing file-doesn't-exist case.
 *
 * This test extracts the REAL python verification block embedded in
 * run-agent-orchestration.sh (not a hand-copied duplicate) and runs it
 * against real fixture projects with a real vitest binary (borrowed from
 * this repo's own node_modules — no fresh install needed).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const NODE_BIN = process.execPath;

function extractFuzzVerifyPython(): string {
  const startMarker = 'import json, sys, os, re, subprocess, shutil';
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error('fuzz-verify python block not found');
  const end = orchSrc.indexOf('\nPYEOF', start);
  if (end === -1) throw new Error('PYEOF terminator not found');
  return orchSrc.slice(start, end);
}

function makeFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-verify-fixture-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  // Reuse this repo's own installed vitest instead of a fresh npm install.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(
    join(dir, 'src', 'server.ts'),
    `export function parseAdults(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 1;
  const s = String(raw);
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}
`,
  );
  return dir;
}

function runVerification(fuzzLogContent: string, projectRoot: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-verify-run-'));
  try {
    const logPath = join(dir, 'fuzz-log.txt');
    writeFileSync(logPath, fuzzLogContent);
    const pythonScript = extractFuzzVerifyPython();
    const scriptPath = join(dir, 'verify.py');
    writeFileSync(scriptPath, pythonScript);
    const output = execFileSync('python3', [scriptPath, logPath, projectRoot, NODE_BIN], {
      encoding: 'utf8',
      timeout: 30000,
    });
    return parseInt(output.trim(), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fuzz-weaver executable-evidence verification — REAL execution', () => {
  it('a FALSE vulnerability claim (test asserts safe behavior, which the real code already satisfies) is NOT confirmed', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'vulnerability',
            executableTest: `import { describe, it, expect } from 'vitest';
import { parseAdults } from '../src/server';
describe('parseAdults', () => {
  it('rejects zero', () => {
    expect(parseAdults('0')).toBeNull();
  });
});
`,
          },
        ],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('a TRUE vulnerability claim (test asserts safe behavior, which the real buggy code violates) IS confirmed', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'vulnerability',
            // parseAdults returns 1e21 (not null) for absurdly large numeric
            // strings — a real, demonstrable gap in the fixture above.
            executableTest: `import { describe, it, expect } from 'vitest';
import { parseAdults } from '../src/server';
describe('parseAdults', () => {
  it('rejects absurdly large numbers', () => {
    expect(parseAdults('999999999999999999999')).toBeNull();
  });
});
`,
          },
        ],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('a claim referencing a file that does not exist is never executed and never confirmed', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'ghostFunction',
            file: 'src/does-not-exist.ts',
            status: 'vulnerability',
            executableTest: `import { describe, it, expect } from 'vitest';
describe('ghost', () => { it('fails on purpose', () => { expect(true).toBe(false); }); });
`,
          },
        ],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('a vulnerability case with NO executableTest field is treated as unverified, not confirmed', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [{ function: 'parseAdults', file: 'src/server.ts', status: 'vulnerability' }],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('non-vulnerability cases (covered/gap) are ignored entirely, even with a failing executableTest', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'gap',
            executableTest: `import { describe, it, expect } from 'vitest';
describe('irrelevant', () => { it('fails', () => { expect(true).toBe(false); }); });
`,
          },
        ],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('a syntactically broken executableTest is treated as unverified (does not crash, does not confirm)', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'vulnerability',
            executableTest: `this is not valid typescript at all {{{`,
          },
        ],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('the .fuzz-verify scratch directory is cleaned up after verification, regardless of outcome', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'vulnerability',
            executableTest: `import { describe, it, expect } from 'vitest';
import { parseAdults } from '../src/server';
describe('x', () => { it('y', () => { expect(parseAdults('0')).toBeNull(); }); });
`,
          },
        ],
      });
      runVerification(fuzzLog, project);
      expect(() => readFileSync(join(project, '.fuzz-verify', 'case-0.test.ts'))).toThrow();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('multiple vulnerability cases are each verified independently', () => {
    const project = makeFixtureProject();
    try {
      const fuzzLog = JSON.stringify({
        agent: 'fuzz-weaver',
        cases: [
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'vulnerability',
            executableTest: `import { describe, it, expect } from 'vitest';
import { parseAdults } from '../src/server';
describe('a', () => { it('false claim', () => { expect(parseAdults('0')).toBeNull(); }); });
`,
          },
          {
            function: 'parseAdults',
            file: 'src/server.ts',
            status: 'vulnerability',
            executableTest: `import { describe, it, expect } from 'vitest';
import { parseAdults } from '../src/server';
describe('b', () => { it('true claim', () => { expect(parseAdults('999999999999999999999')).toBeNull(); }); });
`,
          },
        ],
      });
      const confirmed = runVerification(fuzzLog, project);
      expect(confirmed).toBe(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('perf-sentinel gate — no-structured-output is non-blocking', () => {
  it('when perf_exit is non-zero (no structured output), the pipeline treats it as warn not fail', () => {
    // Mirrors the fuzz-weaver fix: exit 1 from _run_qa_gate_with_retry exhausting
    // all retries with no JSON must NOT set failed=1. A gate that couldn't produce
    // output is not a confirmed failure — only a grounded "verdict":"fail" (exit 0
    // path) should block. Verified structurally against run-agent-orchestration.sh.
    const perfSection = (() => {
      const start = orchSrc.indexOf('if [ $perf_exit -ne 0 ]; then');
      expect(start).toBeGreaterThan(-1);
      return orchSrc.slice(start, start + 900);
    })();
    // Must NOT set failed=1 immediately on non-zero exit
    const failedSetIdx = perfSection.indexOf('failed=1');
    const warnIdx = perfSection.indexOf('non-blocking warn');
    if (failedSetIdx !== -1) {
      expect(warnIdx).toBeGreaterThan(-1);
      expect(warnIdx).toBeLessThan(failedSetIdx);
    } else {
      expect(warnIdx).toBeGreaterThan(-1);
    }
    // Must downgrade perf_exit to 0 so it doesn't propagate to _failing_logs
    expect(perfSection).toMatch(/perf_exit=0/);
  });
});

describe('fuzz-weaver gate — no-structured-output is non-blocking', () => {
  it('when fuzz_exit is non-zero (no structured output), the pipeline treats it as warn not fail', () => {
    // The fix: exit 1 from _run_qa_gate_with_retry (all retries exhausted,
    // no JSON produced) must NOT set failed=1. Only a grounded "verdict":"fail"
    // in the log (exit 0 path) should block. Verified structurally.
    const fuzzSection = (() => {
      const start = orchSrc.indexOf('if [ $fuzz_exit -ne 0 ]; then');
      expect(start).toBeGreaterThan(-1);
      return orchSrc.slice(start, start + 600);
    })();
    // Must NOT set failed=1 immediately on non-zero exit
    const failedSetIdx = fuzzSection.indexOf('failed=1');
    const warnIdx = fuzzSection.indexOf('non-blocking warn');
    // warn message must come before any failed=1 assignment (if one exists)
    if (failedSetIdx !== -1) {
      expect(warnIdx).toBeGreaterThan(-1);
      expect(warnIdx).toBeLessThan(failedSetIdx);
    } else {
      // preferred: no failed=1 in the non-zero exit branch at all
      expect(warnIdx).toBeGreaterThan(-1);
    }
    // Must downgrade fuzz_exit to 0 so it doesn't propagate to _failing_logs
    expect(fuzzSection).toMatch(/fuzz_exit=0/);
  });
});

describe('fuzz-weaver prompt — structural checks', () => {
  // Extract only the fuzz-weaver prompt block (not the entire script).
  // Anchor: start = "You are acting as the fuzz-weaver agent."
  // End: the closing double-quote of the fuzz_prompt bash variable, which
  // immediately precedes the profile-prepend if-block.
  // Use "no markdown fences, no preamble" — unique to the fuzz prompt's
  // output format line and not shared with any other gate prompt.
  // THE TEMPLATE, not a slice of the script.
  //
  // This used to anchor on two phrases inside run-agent-orchestration.sh and slice between
  // them — a technique that needed the second phrase to be unique to this prompt, and broke
  // the moment the prompt moved into the template layer (2026-08-15). The template IS the
  // block, so there is nothing to delimit.
  function extractFuzzPromptBlock(): string {
    return JSON.parse(readFileSync(
      join(REPO_ROOT, 'orchestrations/prompts/templates/qa-fuzz-weaver.json'), 'utf8')).body as string;
  }

  it('the fuzz prompt includes an executableTest field in the output schema', () => {
    const block = extractFuzzPromptBlock();
    expect(block).toMatch(/executableTest/);
  });

  it('the fuzz prompt instructs the model not to execute tests (no-execute contract)', () => {
    const block = extractFuzzPromptBlock();
    // Since the timeout fix: model must NOT run tests, only write skeleton
    expect(block).toMatch(/Do NOT run or execute|Do NOT.*execute|do not.*run.*test/i);
  });

  it('the fuzz prompt output format instructs the model not to write to a file', () => {
    const block = extractFuzzPromptBlock();
    expect(block).toMatch(/do NOT write to a file|emit directly/i);
  });

  it('the gate step calls detect_node before invoking the python verification block', () => {
    const pyIdx = orchSrc.indexOf('import json, sys, os, re, subprocess, shutil');
    const detectNodeIdx = orchSrc.lastIndexOf('detect_node', pyIdx);
    expect(detectNodeIdx).toBeGreaterThan(-1);
    expect(pyIdx - detectNodeIdx).toBeLessThan(300);
  });

  it('_run_qa_gate_with_retry retry prefix detects WriteFile-instead-of-stdout and corrects it', () => {
    // The retry branch must contain a WriteFile-specific correction when the log
    // is small and contains the "has been written" tool confirmation phrase.
    const retryIdx = orchSrc.indexOf('_run_qa_gate_with_retry()');
    expect(retryIdx).toBeGreaterThan(-1);
    const retryFnEnd = orchSrc.indexOf('\n}', retryIdx + 100);
    const retryFn = orchSrc.slice(retryIdx, retryFnEnd);
    // Must detect the WriteFile confirmation phrase
    expect(retryFn).toMatch(/has been written/);
    // Must include a corrective instruction naming WriteFile explicitly
    expect(retryFn).toMatch(/WriteFile/);
    // Must include a file-recovery search
    expect(retryFn).toMatch(/recovering from|recovered|WriteFile recovery/);
  });
});
