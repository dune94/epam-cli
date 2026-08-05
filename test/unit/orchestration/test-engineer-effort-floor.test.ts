/**
 * resolve_test_engineer_effort_floor — test-writing structurally requires
 * MORE research/verification turns than implementation at the same nominal
 * effort tier, so test-engineer stories get their iteration/token budget
 * bumped one tier up.
 *
 * User observation (2026-07-11, after watching a live tier3-travel-app run):
 * "do we have a fundamental issue with test writing? it is far less
 * effective than implementing writer" — confirmed by evidence from that
 * exact run: every impl story at effort=low (maxIter=6) completed in 1
 * attempt (SKY-001A, SKY-001B, SKY-002-impl, SKY-003-impl); SKY-004-impl
 * needed effort=high (maxIter=15) and still took 3 attempts, showing the
 * effort/maxIter budget genuinely matters. SKY-002-test, at the SAME
 * effort=low (maxIter=6) budget as the trivially-succeeding impl stories,
 * needed a capability-failure retry AND a full watchdog timeout (600s) —
 * neither attempt even reached npm test — before finally starting a third
 * attempt. The test-engineer profile itself requires reading a contract
 * file, reading the paired impl story's full source, extracting exact
 * signatures/error strings verbatim, writing mocks, THEN iterating to a
 * passing test run — strictly more sub-steps than an impl story of the same
 * nominal effort defining its own interface as it goes. Root cause: effort
 * is estimated once at spec-pass time and never adjusted for the structurally
 * heavier test-writing workflow.
 *
 * Fix: bump the iteration/token budget one tier for any story whose
 * agentRole is "test-engineer" (low->medium, medium->high); high stays high.
 * Never lowers the budget.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// These budgets moved to orchestrations/config/llm-defaults.json, so a harness that runs the
// extracted function ALONE leaves them unset. Run the real loader first, as the pipeline
// does — this keeps the test measuring its own logic rather than missing configuration.
const _AUTOMATION = join(__dirname, '../../../orchestrations');

function extractFunctionByBraceCount(name: string): string {
  const start = claudeSrc.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  const braceStart = claudeSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < claudeSrc.length; i++) {
    if (claudeSrc[i] === '{') depth++;
    else if (claudeSrc[i] === '}') {
      depth--;
      if (depth === 0) return claudeSrc.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

const _loaderFn = extractFunctionByBraceCount('load_llm_settings_json');

describe('resolve_test_engineer_effort_floor — wiring (static)', () => {
  it('is defined', () => {
    expect(claudeSrc).toMatch(/resolve_test_engineer_effort_floor\(\) \{/);
  });

  it('is called right after resolve_generator_settings, before provider resolution', () => {
    const genIdx = claudeSrc.indexOf('resolve_generator_settings "$story_id"');
    const floorIdx = claudeSrc.indexOf('resolve_test_engineer_effort_floor "$story_id"');
    const providerIdx = claudeSrc.indexOf('resolve_provider_settings "$story_id"');
    expect(genIdx).toBeGreaterThan(-1);
    expect(floorIdx).toBeGreaterThan(genIdx);
    expect(providerIdx).toBeGreaterThan(floorIdx);
  });

  it('only applies to agentRole == "test-engineer"', () => {
    const body = extractFunctionByBraceCount('resolve_test_engineer_effort_floor');
    expect(body).toMatch(/\[ "\$role" = "test-engineer" \] \|\| return 0/);
  });
});

describe('resolve_test_engineer_effort_floor — REAL execution', () => {
  function run(opts: { agentRole: string; effort?: string }): { maxIter: string; maxOutTok: string } {
    const dir = mkdtempSync(join(tmpdir(), 'test-eng-floor-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{ id: 'SKY-002-test', agentRole: opts.agentRole, effort: opts.effort }],
        }),
      );
      const fnBody = extractFunctionByBraceCount('resolve_test_engineer_effort_floor');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          'log() { :; }',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `AUTOMATION_DIR=${JSON.stringify(_AUTOMATION)}`,
          _loaderFn,
          'load_llm_settings_json',
          'STORY_MAX_ITERATIONS=6',
          'STORY_MAX_OUTPUT_TOKENS=3072',
          fnBody,
          'resolve_test_engineer_effort_floor "SKY-002-test"',
          'echo "MAXITER=$STORY_MAX_ITERATIONS"',
          'echo "MAXTOK=$STORY_MAX_OUTPUT_TOKENS"',
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const maxIter = output.match(/MAXITER=(\d+)/)?.[1] ?? '';
      const maxOutTok = output.match(/MAXTOK=(\d+)/)?.[1] ?? '';
      return { maxIter, maxOutTok };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live shape and proves the fix: a test-engineer story at effort=low is bumped to medium\'s budget (maxIter 6 -> 10)', () => {
    const { maxIter, maxOutTok } = run({ agentRole: 'test-engineer', effort: 'low' });
    expect(maxIter).toBe('10');
    expect(maxOutTok).toBe('6144');
  });

  it('bumps effort=medium to high\'s budget (maxIter -> 15)', () => {
    const { maxIter, maxOutTok } = run({ agentRole: 'test-engineer', effort: 'medium' });
    expect(maxIter).toBe('15');
    expect(maxOutTok).toBe('6144');
  });

  it('leaves effort=high untouched (already the largest budget)', () => {
    const { maxIter, maxOutTok } = run({ agentRole: 'test-engineer', effort: 'high' });
    expect(maxIter).toBe('6'); // unchanged from the pre-set value in this harness — proves no-op
    expect(maxOutTok).toBe('3072');
  });

  it('does NOT touch a non-test-engineer story (typescript-engineer keeps its own effort-based budget)', () => {
    const { maxIter, maxOutTok } = run({ agentRole: 'typescript-engineer', effort: 'low' });
    expect(maxIter).toBe('6'); // unchanged from the pre-set value in this harness
    expect(maxOutTok).toBe('3072');
  });

  it('is domain-agnostic: works regardless of the actual story ID or project (no hardcoded IDs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-eng-floor-agnostic-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{ id: 'PAYMENT-042-test', agentRole: 'test-engineer', effort: 'low' }],
        }),
      );
      const fnBody = extractFunctionByBraceCount('resolve_test_engineer_effort_floor');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          'log() { :; }',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `AUTOMATION_DIR=${JSON.stringify(_AUTOMATION)}`,
          _loaderFn,
          'load_llm_settings_json',
          'STORY_MAX_ITERATIONS=6',
          'STORY_MAX_OUTPUT_TOKENS=3072',
          fnBody,
          'resolve_test_engineer_effort_floor "PAYMENT-042-test"',
          'echo "MAXITER=$STORY_MAX_ITERATIONS"',
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(output).toMatch(/MAXITER=10/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
