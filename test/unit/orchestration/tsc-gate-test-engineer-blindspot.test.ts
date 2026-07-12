/**
 * Flow-gap investigation (2026-07-12, live tier3-travel-app run): a live run
 * hit FIVE distinct syntax-class errors (unterminated string literals,
 * mismatched parens, an "unexpected '2026'" typo, misplaced tokens) across
 * only a handful of stories, EVERY ONE of them in a `.test.ts` file written
 * by a `test-engineer`-role story. Each one was only discovered after a
 * full external `npm test` run failed, then required an LLM (FailureAnalyst)
 * call to diagnose it, before SyntaxClassEscalation bumped the model tier
 * and retried — several LLM calls and a full multi-minute test run spent per
 * typo that `tsc --noEmit` (or even `node --check`) would have caught
 * instantly, for free, in the same turn.
 *
 * ROOT CAUSE — two compounding defects in claude.sh, both confirmed by
 * reading the code directly:
 *
 * DEFECT A: run_tsc_verification() explicitly skips exactly the role that
 * was failing:
 *   local _role
 *   _role=$(jq -r ... .agentRole // "" ...)
 *   [ "$_role" = "test-engineer" ] && return 0
 * Every syntax error observed live was in a .test.ts file written by a
 * test-engineer story — precisely the case this skip disables the check for.
 *
 * DEFECT B (compounding, even for non-test-engineer stories): the tsc check
 * only runs AFTER run_external_verification (the full, often multi-minute
 * `npm test`) already ran and (for a syntax error) already failed — see the
 * call-site order at the invoke_success gate chain. A cheap syntax check
 * that could short-circuit a doomed test run instead runs only after paying
 * for that run.
 *
 * Agents are constitutionally forbidden from self-verifying (AGENT_
 * CONSTITUTION, claude.sh: "Do NOT run compilers (tsc), test suites ...");
 * this is a deliberate cost/speed tradeoff, not a bug — so the ORCHESTRATOR
 * (this deterministic check) is the only thing that can ever catch a syntax
 * error before the expensive path. Skipping it for test-engineer stories and
 * running it too late defeats that entirely for the failure class that was
 * actually recurring live.
 *
 * WHY EXISTING TESTS MISSED THIS: tsc-retry-in-loop.test.ts — the test file
 * covering run_tsc_verification() — contains two assertions that don't just
 * fail to catch this, they actively CODIFY both defects as correct,
 * intended behavior:
 *   it('skips for test-engineer role stories', ...)
 *   it('is called after run_external_verification, before the success
 *       branch', ...)
 * Those tests pass today precisely because the code has the bug; a test
 * asserting a defect as a feature will never surface the defect. This file's
 * tests replace those two assertions with the corrected behavior, verified
 * via genuine execution against a real syntax error, not just source-text
 * pattern matching.
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

// Runs the REAL run_tsc_verification() function body against a genuine
// project directory containing an actual syntax error in a .test.ts file —
// real execution (real tsc, real node), not a text-pattern check.
function runTscVerification(opts: { agentRole: string; testFileContent: string }): {
  rc: number;
  output: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-gate-blindspot-'));
  try {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, noEmit: true }, include: ['src'] }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
    writeFileSync(join(dir, 'src', 'index.test.ts'), opts.testFileContent);

    // A minimal real node_modules/.bin/tsc is impractical to stub faithfully;
    // use the REAL project's tsc binary (already required by CLAUDE.md for
    // this repo) against this isolated tmp project via its own tsconfig.
    const nodeBin = `${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node`;
    const tscBin = join(REPO_ROOT, 'node_modules/.bin/tsc');

    const prdPath = join(dir, 'prd.json');
    writeFileSync(
      prdPath,
      JSON.stringify({ stories: [{ id: 'SKY-TEST', agentRole: opts.agentRole, technicalNotes: { files: ['src/index.test.ts'] } }] }),
    );

    const fnBody = extractFunctionBody('run_tsc_verification');
    const outLog = join(dir, 'out.log');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        `PROJECT_ROOT=${JSON.stringify(dir)}`,
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
        `NODE_CMD=${JSON.stringify(nodeBin)}`,
        'log() { echo "LOG: $*" >&2; }',
        'warning() { echo "WARN: $*" >&2; }',
        'success() { echo "SUCCESS: $*" >&2; }',
        fnBody,
        `run_tsc_verification "SKY-TEST" ${JSON.stringify(outLog)}`,
        'echo "RC=$?"',
        '',
      ].join('\n'),
    );
    // Symlink the real tsc into this tmp project's node_modules/.bin so the
    // function's hardcoded relative path resolves.
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    try {
      execFileSync('ln', ['-sf', tscBin, join(dir, 'node_modules', '.bin', 'tsc')]);
    } catch {
      /* ignore */
    }

    let output = '';
    let rc = -1;
    try {
      output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      rc = 0;
    } catch (e: any) {
      output = ((e.stdout ?? '').toString()) + ((e.stderr ?? '').toString());
      rc = e.status ?? -1;
    }
    const rcMatch = output.match(/RC=(\d+)/);
    return { rc: rcMatch ? parseInt(rcMatch[1], 10) : rc, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Deliberately does NOT import vitest (or any external package) -- the
// isolated tmp project has no node_modules/vitest, and importing it would
// make tsc fail with an unrelated module-resolution error (TS2307),
// masking the actual syntax-error class under test.
const BROKEN_TEST_FILE = `import { add } from './index';

function assertEqual(actual: number, expected: number): void {
  if (actual !== expected) throw new Error('mismatch');
}

assertEqual(add(1, 2), 3
`; // missing closing paren — a real, common LLM slip

const VALID_TEST_FILE = `import { add } from './index';

function assertEqual(actual: number, expected: number): void {
  if (actual !== expected) throw new Error('mismatch');
}

assertEqual(add(1, 2), 3);
`;

describe('DEFECT A — run_tsc_verification() must NOT blanket-skip test-engineer stories', () => {
  it('REPRODUCES the live gap: a genuine syntax error in a .test.ts file written by a test-engineer story goes completely undetected', () => {
    const { rc } = runTscVerification({ agentRole: 'test-engineer', testFileContent: BROKEN_TEST_FILE });
    // Desired (post-fix) behavior: rc === 1, the syntax error is caught.
    // Today (bug): rc === 0 — the check silently skips and returns success.
    expect(rc).toBe(1);
  });

  it('still passes cleanly for a syntactically valid test-engineer file (no false positives introduced)', () => {
    const { rc } = runTscVerification({ agentRole: 'test-engineer', testFileContent: VALID_TEST_FILE });
    expect(rc).toBe(0);
  });

  it('non-test-engineer roles (already covered pre-fix) still catch the same error class', () => {
    const { rc } = runTscVerification({ agentRole: 'typescript-engineer', testFileContent: BROKEN_TEST_FILE });
    expect(rc).toBe(1);
  });
});

describe('DEFECT B — the tsc/syntax check must run BEFORE external verification (npm test), not after', () => {
  it('run_tsc_verification is invoked before run_external_verification in the invoke_success gate chain', () => {
    const extIdx = claudeSrc.indexOf('! run_external_verification "$story_id" "$output_file"');
    const tscIdx = claudeSrc.indexOf('! run_tsc_verification "$story_id" "$output_file"');
    expect(extIdx).toBeGreaterThan(-1);
    expect(tscIdx).toBeGreaterThan(-1);
    // Desired (post-fix): tscIdx before extIdx. Today (bug): tscIdx > extIdx.
    expect(tscIdx).toBeLessThan(extIdx);
  });
});
