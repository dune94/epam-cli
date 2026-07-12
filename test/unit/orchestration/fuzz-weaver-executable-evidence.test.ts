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

describe('fuzz-weaver prompt — executableTest requirement wired in (structural)', () => {
  it('the fuzz prompt requires an executableTest field for vulnerability cases', () => {
    const promptIdx = orchSrc.indexOf('You are acting as the fuzz-weaver agent.');
    expect(promptIdx).toBeGreaterThan(-1);
    const nextSectionIdx = orchSrc.indexOf('Output format (strict JSON)', promptIdx);
    const promptBlock = orchSrc.slice(promptIdx, nextSectionIdx);
    expect(promptBlock).toMatch(/executableTest/);
    expect(promptBlock).toMatch(/actually executed/);
  });

  it('the gate step calls detect_node before invoking the python verification block', () => {
    const pyIdx = orchSrc.indexOf('import json, sys, os, re, subprocess, shutil');
    const detectNodeIdx = orchSrc.lastIndexOf('detect_node', pyIdx);
    expect(detectNodeIdx).toBeGreaterThan(-1);
    expect(pyIdx - detectNodeIdx).toBeLessThan(300);
  });
});
