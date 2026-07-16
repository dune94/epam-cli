/**
 * Complexity-adaptive plan-then-execute (2026-07-07).
 *
 * Two mechanisms already existed in claude.sh before this change:
 *   - run_planning_phase(): produces a plan, injected into every execution
 *     attempt as "## Execution Plan" — but only when a story explicitly set
 *     .plannerModel in the PRD (nobody does, in practice this never fired).
 *   - classify_ladder_tier(): a complexity signal (CPA cpaGate/effort -> PRD
 *     .ladderTier, with a retry-history fallback) already used to pick the
 *     model-escalation ladder (medium vs high).
 *
 * This change reuses classify_ladder_tier() to ALSO decide execution shape:
 * a "high" tier story now gets an auto-triggered plan-turn on its very first
 * attempt (resolve_planner_settings), and the plan is now reviewed against
 * ground-truth dependency contracts before being trusted (review_and_correct_plan)
 * — closing the "plan was injected completely unreviewed" gap.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBodyBraceCounted(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
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

describe('claude.sh — plan-then-execute functions are defined', () => {
  it('resolve_planner_settings, review_and_correct_plan exist', () => {
    expect(claudeSrc).toMatch(/resolve_planner_settings\s*\(\)/);
    expect(claudeSrc).toMatch(/review_and_correct_plan\s*\(\)/);
  });

  it('review_and_correct_plan is wired into implement_story right after run_planning_phase', () => {
    const idx = claudeSrc.indexOf('story_plan=$(run_planning_phase');
    expect(idx).toBeGreaterThan(-1);
    const nextLines = claudeSrc.slice(idx, idx + 200);
    expect(nextLines).toMatch(/story_plan=\$\(review_and_correct_plan "\$story_id" "\$story_plan"\)/);
  });
});

describe('resolve_planner_settings — complexity-adaptive auto-trigger (REAL execution)', () => {
  function run(opts: {
    ladderTier?: string;
    plannerModelField?: string;
    skipPlanThenExecute?: boolean;
    envPlannerHighTier?: string;
    orchGateModel?: string;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), 'planner-settings-test-'));
    try {
      const resolveBody = extractFunctionBodyBraceCounted('resolve_planner_settings');
      const classifyBody = extractFunctionBodyBraceCounted('classify_ladder_tier');
      const prdFile = join(dir, 'prd.json');
      const prd = {
        stories: [
          {
            id: 'SKY-999',
            ladderTier: opts.ladderTier,
            plannerModel: opts.plannerModelField,
          },
        ],
      };
      writeFileSync(prdFile, JSON.stringify(prd));
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `log() { :; }`,
          `warning() { :; }`,
          opts.skipPlanThenExecute ? `SKIP_PLAN_THEN_EXECUTE=true` : '',
          opts.envPlannerHighTier ? `EPAM_PLANNER_MODEL_HIGH_TIER="${opts.envPlannerHighTier}"` : 'unset EPAM_PLANNER_MODEL_HIGH_TIER',
          opts.orchGateModel ? `ORCH_GATE_MODEL="${opts.orchGateModel}"` : 'unset ORCH_GATE_MODEL',
          classifyBody,
          resolveBody,
          `resolve_planner_settings "SKY-999"`,
          `echo "STORY_PLANNER_MODEL=\${STORY_PLANNER_MODEL:-}"`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('auto-triggers a plan turn for a "high" tier story when EPAM_PLANNER_MODEL_HIGH_TIER is configured', () => {
    const out = run({ ladderTier: 'high', envPlannerHighTier: 'some-planner-model' });
    expect(out).toBe('STORY_PLANNER_MODEL=some-planner-model');
  });

  it('falls back to ORCH_GATE_MODEL when EPAM_PLANNER_MODEL_HIGH_TIER is unset', () => {
    const out = run({ ladderTier: 'high', orchGateModel: 'gate-model-x' });
    expect(out).toBe('STORY_PLANNER_MODEL=gate-model-x');
  });

  it('does NOT auto-trigger for "medium" tier (default) — simple stories keep single-shot, zero overhead', () => {
    const out = run({ ladderTier: 'medium', envPlannerHighTier: 'some-planner-model' });
    expect(out).toBe('STORY_PLANNER_MODEL=');
  });

  it('does NOT auto-trigger when neither EPAM_PLANNER_MODEL_HIGH_TIER nor ORCH_GATE_MODEL is set, even for high tier', () => {
    const out = run({ ladderTier: 'high' });
    expect(out).toBe('STORY_PLANNER_MODEL=');
  });

  it('SKIP_PLAN_THEN_EXECUTE=true disables the auto-trigger even for a high-tier story', () => {
    const out = run({ ladderTier: 'high', envPlannerHighTier: 'some-planner-model', skipPlanThenExecute: true });
    expect(out).toBe('STORY_PLANNER_MODEL=');
  });

  it('an explicit PRD .plannerModel field always takes precedence over the auto-trigger (manual override still works)', () => {
    const out = run({
      ladderTier: 'medium',
      plannerModelField: 'manually-pinned-planner',
      envPlannerHighTier: 'some-planner-model',
    });
    expect(out).toBe('STORY_PLANNER_MODEL=manually-pinned-planner');
  });
});

describe('review_and_correct_plan — plan/reality gate (REAL execution, stubbed ai-run.sh)', () => {
  function run(opts: {
    dependencies?: string[];
    contracts?: Record<string, string>;
    aiRunScript: string;
  }): { stdout: string; callCount: number } {
    const dir = mkdtempSync(join(tmpdir(), 'plan-review-test-'));
    try {
      const reviewBody = extractFunctionBodyBraceCounted('review_and_correct_plan');
      const prdFile = join(dir, 'prd.json');
      const prd = {
        stories: [{ id: 'SKY-999', dependencies: opts.dependencies ?? [] }],
      };
      writeFileSync(prdFile, JSON.stringify(prd));

      const scriptsDir = join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const callLog = join(dir, 'calls.txt');
      writeFileSync(
        join(scriptsDir, 'ai-run.sh'),
        `#!/bin/bash\necho called >> "${callLog}"\n${opts.aiRunScript}\n`,
      );
      chmodSync(join(scriptsDir, 'ai-run.sh'), 0o755);

      if (opts.contracts) {
        const contractsDir = join(dir, '.contracts');
        mkdirSync(contractsDir, { recursive: true });
        for (const [id, content] of Object.entries(opts.contracts)) {
          writeFileSync(join(contractsDir, `${id}.md`), content);
        }
      }

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `PROJECT_ROOT="${dir}"`,
          `SCRIPT_DIR="${scriptsDir}"`,
          `EPAM_ORCHESTRATION_PROVIDER="claude"`,
          `ORCH_GATE_MODEL="gate-model"`,
          `EPAM_CLI="epam"`,
          `warning() { :; }`,
          reviewBody,
          `review_and_correct_plan "SKY-999" "1. Do the thing."`,
        ].join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      let callCount = 0;
      try {
        callCount = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).length;
      } catch {
        callCount = 0;
      }
      return { stdout, callCount };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('no dependencies — returns the plan unchanged and never calls ai-run.sh (nothing to check against)', () => {
    const { stdout, callCount } = run({ dependencies: [], aiRunScript: 'echo should-not-run' });
    expect(stdout).toBe('1. Do the thing.');
    expect(callCount).toBe(0);
  });

  it('dependency declared but no contract file exists yet — returns the plan unchanged, no call', () => {
    const { stdout, callCount } = run({
      dependencies: ['SKY-002'],
      aiRunScript: 'echo should-not-run',
    });
    expect(stdout).toBe('1. Do the thing.');
    expect(callCount).toBe(0);
  });

  it('contract exists, review verdict is "ok" — returns the original plan unchanged, exactly one review call', () => {
    const { stdout, callCount } = run({
      dependencies: ['SKY-002'],
      contracts: { 'SKY-002': '# SKY-002 contract\nexport class SkyscannerClient {}' },
      aiRunScript: `echo '{"verdict":"ok"}'`,
    });
    expect(stdout).toBe('1. Do the thing.');
    expect(callCount).toBe(1);
  });

  it('contract exists, review verdict is "mismatch" — makes exactly ONE corrective re-plan call and returns the corrected plan', () => {
    // ai-run.sh's wrapper appends one "called" line to callLog (absolute path,
    // injected below) BEFORE running this stub body, so the stub can tell first
    // call (review) from second call (corrective re-plan) by how many lines
    // callLog already has.
    const dir = mkdtempSync(join(tmpdir(), 'plan-review-mismatch-'));
    try {
      const reviewBody = extractFunctionBodyBraceCounted('review_and_correct_plan');
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [{ id: 'SKY-999', dependencies: ['SKY-002'] }] }));
      const scriptsDir = join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const callLog = join(dir, 'calls.txt');
      writeFileSync(
        join(scriptsDir, 'ai-run.sh'),
        `#!/bin/bash
echo called >> "${callLog}"
n=$(wc -l < "${callLog}" | tr -d ' ')
if [ "$n" -eq 1 ]; then
  echo '{"verdict":"mismatch","corrections":"Use SkyscannerClient from SKY-002, not a hallucinated path."}'
else
  echo "1. Corrected plan using real SkyscannerClient contract."
fi
`,
      );
      chmodSync(join(scriptsDir, 'ai-run.sh'), 0o755);
      const contractsDir = join(dir, '.contracts');
      mkdirSync(contractsDir, { recursive: true });
      writeFileSync(join(contractsDir, 'SKY-002.md'), '# SKY-002 contract\nexport class SkyscannerClient {}');

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `PROJECT_ROOT="${dir}"`,
          `SCRIPT_DIR="${scriptsDir}"`,
          `EPAM_ORCHESTRATION_PROVIDER="claude"`,
          `ORCH_GATE_MODEL="gate-model"`,
          `EPAM_CLI="epam"`,
          `warning() { :; }`,
          reviewBody,
          `review_and_correct_plan "SKY-999" "1. Do the thing."`,
        ].join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      const callCount = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).length;

      expect(callCount).toBe(2);
      expect(stdout).toBe('1. Corrected plan using real SkyscannerClient contract.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty plan text is a no-op — returns immediately, no ai-run.sh call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-review-empty-'));
    try {
      const reviewBody = extractFunctionBodyBraceCounted('review_and_correct_plan');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [`warning() { :; }`, reviewBody, `review_and_correct_plan "SKY-999" ""`, `echo "END"`].join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      expect(stdout).toBe('END');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
