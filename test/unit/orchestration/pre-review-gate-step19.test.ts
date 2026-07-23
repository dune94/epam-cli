/**
 * Step 19 (Pre-review build gate: vitest + tsc) — REAL execution of the
 * actual, unmodified code block from run-agent-orchestration.sh, against a
 * real fixture, fast and deterministic (no LLM calls, no 10-minute full
 * pipeline run).
 *
 * Built 2026-07-23 after Step 19 failed twice in a row inside the full
 * mock1 pipeline run with `tsconfig.json(4,25): error TS5108: Option
 * 'moduleResolution=node10' has been removed`, on a tsconfig that passed
 * cleanly in an isolated manual reproduction — proving the isolated
 * reproduction was not faithful to the real gate. This test runs Step 19's
 * OWN real code (extracted by marker, not re-implemented) so any future
 * discrepancy between "my repro" and "the real gate" is impossible.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const RUN_AGENT_ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(RUN_AGENT_ORCH, 'utf8');

function extractStep19Block(): string {
  const startMarker = '# Step 3.7: Pre-review build gate';
  const endMarker = '# ──────────────────────────────────────────────\n# Step 3.8';
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error('Step 3.7 start marker not found');
  let end = orchSrc.indexOf(endMarker, start);
  if (end === -1) {
    // Fallback: find the next "# Step 3.8" heading without the exact separator prefix
    end = orchSrc.indexOf('Step 3.8', start);
    if (end === -1) throw new Error('Step 3.8 end marker not found');
  }
  return orchSrc.slice(start, end);
}

const step19Block = extractStep19Block();

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Same detect_node() function, extracted verbatim, so the test uses the
 *  EXACT SAME node-binary resolution Step 19 itself uses — not a hardcoded
 *  path that might silently diverge from the real gate. */
function extractDetectNodeFn(): string {
  const start = orchSrc.indexOf('detect_node() {');
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}
const detectNodeFn = extractDetectNodeFn();

function makeFixture(tsconfigOverride?: Record<string, unknown>): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'step19-gate-'));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'step19-fixture', version: '1.0.0', private: true }, null, 2));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfigOverride ?? {
    compilerOptions: { module: 'CommonJS', moduleResolution: 'node', target: 'ES2020', strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, types: ['vitest/globals', 'node'] },
    include: ['src/**/*.ts'],
  }, null, 2));
  writeFileSync(join(dir, 'src/hello.ts'), "export function getGreeting(): string {\n  return 'hello dolly';\n}\n");
  writeFileSync(join(dir, 'src/hello.test.ts'), [
    "import { describe, it, expect } from 'vitest';",
    "import { getGreeting } from './hello';",
    "describe('getGreeting', () => { it('returns hello dolly', () => { expect(getGreeting()).toBe('hello dolly'); }); });",
    '',
  ].join('\n'));
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  return { dir };
}

function runStep19(projectRoot: string): { rc: number; output: string } {
  const scriptDir = mkdtempSync(join(tmpdir(), 'step19-harness-'));
  cleanupDirs.push(scriptDir);
  const scriptPath = join(scriptDir, 'run.sh');
  writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    'log()     { echo "LOG: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    'error()   { echo "ERROR: $*" >&2; }',
    'warning() { echo "WARNING: $*"; }',
    'step_emit() { :; }',
    'update-monitor.sh() { :; }',
    `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
    `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
    `LOG_DIR=${JSON.stringify(scriptDir)}`,
    'PHASE=test_phase',
    'SKIP_PRE_REVIEW_GATE=false',
    detectNodeFn,
    step19Block,
    'echo "HARNESS_RC=$?"',
  ].join('\n'));
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60000 });
  const combined = (result.stdout || '') + (result.stderr || '');
  const m = combined.match(/HARNESS_RC=(\d+)/);
  return { rc: m ? parseInt(m[1], 10) : (result.status ?? -1), output: combined };
}

describe('Step 19 (Pre-review build gate) — REAL execution of the actual run-agent-orchestration.sh code', () => {
  it('extracted the real block, not an empty/wrong slice', () => {
    expect(step19Block).toMatch(/Running vitest/);
    expect(step19Block).toMatch(/Running tsc --noEmit/);
    expect(step19Block.length).toBeGreaterThan(200);
  });

  it('PASSES with a correct tsconfig.json (moduleResolution: "node", lowercase) and passing tests', () => {
    const { dir } = makeFixture();
    const { rc, output } = runStep19(dir);
    expect(rc, output).toBe(0);
    expect(output).toMatch(/vitest: PASS/);
    expect(output).not.toMatch(/moduleResolution=node10/);
  });

  it('capitalized moduleResolution ("Node") is NOT the trigger — passes cleanly, disproving the initial hypothesis from the live failure', () => {
    // The live mock1 run hit `error TS5108: Option 'moduleResolution=node10'
    // has been removed` twice, and the first fix attempt (lowercasing "Node"
    // -> "node") didn't resolve it — the SAME error recurred verbatim on a
    // SECOND run using the lowercase value. This test proves BOTH spellings
    // pass cleanly against Step 19's real, unmodified code — the actual
    // trigger is something about the live pipeline run's state (a mutated
    // tsconfig.json, a stale file, or similar), not the tsconfig content
    // this repo's test fixture controls. Root cause still open — see
    // [[project_backlog]] for the follow-up to capture the ACTUAL committed
    // tsconfig.json content at the moment of a live Step 19 failure.
    const { dir } = makeFixture({
      compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2020', strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, types: ['vitest/globals', 'node'] },
      include: ['src/**/*.ts'],
    });
    const { rc, output } = runStep19(dir);
    expect(rc, output).toBe(0);
    expect(output).not.toMatch(/moduleResolution=node10/);
  });

  it('run 10x in a row with the correct config — deterministically passes every time (rules out any flakiness in the earlier live failures)', () => {
    const RUNS = 10;
    const outcomes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { dir } = makeFixture();
      const { rc } = runStep19(dir);
      outcomes.push(rc);
    }
    const failures = outcomes.filter(rc => rc !== 0);
    expect(failures, `${failures.length}/${RUNS} failed`).toHaveLength(0);
  }, 60000);
});
