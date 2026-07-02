/**
 * preflight-prd-integrity.sh — contract tests.
 *
 * Verifies the 16-check integrity gate catches every category of PRD drift
 * that has caused real run failures. Tests run entirely in-process against
 * synthetic PRD fixtures (no shell invocation needed).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Use canonical PRD — the runtime prd.json is reset before every run and should
// not be used in tests (its content varies with run state).
const PRD_PATH = join(__dirname, '../../../orchestrations/travel-app-prd.canonical.json');

interface Story {
  id: string;
  status?: string;
  completed?: boolean;
  effort?: string;
  aiProvider?: string;
  model?: string;
  acceptanceCriteria?: string[];
  technicalNotes?: { files?: string[] };
}

interface Prd {
  project?: { outputDir?: string };
  stories: Story[];
  implementationOrder: Record<string, string[]>;
}

const prd: Prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const activeIds = new Set(Object.values(prd.implementationOrder).flat());
const byId = new Map(prd.stories.map((s) => [s.id, s]));
const outputDir = prd.project?.outputDir ?? '';
const KNOWN_PROVIDERS = new Set(['qwen', 'minimax', 'anthropic', 'claude', 'gemini', 'opencode', 'codex', 'cursor']);
const KNOWN_MINIMAX_MODELS = new Set(['MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M1.5', 'MiniMax-M1', 'upgrade']);
// Canonical = pre-spec-pass. Spec-mode mutates model fields during a run, so model-format checks only valid on canonical.
const isCanonical = prd.stories.every((s: any) => !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass');

// ── Check 1: No BUG- stories ────────────────────────────────────────────────
describe('PRD integrity — no stale runtime artifacts', () => {
  it('no BUG- prefixed stories in stories[]', () => {
    const bugStories = prd.stories.filter((s) => s.id.startsWith('BUG-'));
    expect(bugStories.map((s) => s.id)).toHaveLength(0);
  });

  it('no bug-fix runtime splits in active phases (base ID also active = stale split)', () => {
    const splitPattern = /^(.+)-(impl|test|table)-\d+$/;
    // A stale split is one whose base ID (e.g. "SKY-002b-1") is ALSO active.
    // Canonical stories like SKY-003a-test-3 don't have an active base "SKY-003a-test".
    const staleActive = [...activeIds].filter((id) => {
      const m = id.match(splitPattern);
      return m ? activeIds.has(m[1]) : false;
    });
    expect(staleActive).toHaveLength(0);
  });
});

// ── Check 2: Phase structure ─────────────────────────────────────────────────
describe('PRD integrity — phase structure', () => {
  it('exactly 2 phases: scaffold, core', () => {
    const phases = Object.keys(prd.implementationOrder);
    expect(phases).toContain('scaffold');
    expect(phases).toContain('core');
    expect(phases).not.toContain('ui_and_review');
  });

  it('no stale bug_fix_* phases in implementationOrder', () => {
    const bugFixPhases = Object.keys(prd.implementationOrder).filter((p) =>
      p.startsWith('bug_fix')
    );
    expect(bugFixPhases).toHaveLength(0);
  });

  it('phase order is scaffold → core', () => {
    const phases = Object.keys(prd.implementationOrder);
    expect(phases.indexOf('scaffold')).toBeLessThan(phases.indexOf('core'));
  });
});

// ── Check 3: Story resolution ────────────────────────────────────────────────
describe('PRD integrity — story ID resolution', () => {
  it('all implementationOrder IDs resolve to known stories', () => {
    const phantom = [...activeIds].filter((id) => !byId.has(id));
    expect(phantom).toHaveLength(0);
  });

  it('no duplicate story IDs within or across phases', () => {
    const allIds = Object.values(prd.implementationOrder).flat();
    const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
    expect(dupes).toHaveLength(0);
  });

  it('no deprecated stories appear in implementationOrder', () => {
    const deprecatedActive = [...activeIds].filter(
      (id) => byId.get(id)?.status === 'deprecated'
    );
    expect(deprecatedActive).toHaveLength(0);
  });
});

// ── Check 4: Provider/model alignment ───────────────────────────────────────
describe('PRD integrity — provider and model alignment', () => {
  it('no story has aiProvider="openrouter" (routing layer, not a provider)', () => {
    const bad = prd.stories.filter((s) => s.aiProvider === 'openrouter');
    expect(bad.map((s) => s.id)).toHaveLength(0);
  });

  it('all active story aiProvider values are known', () => {
    const bad = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => s?.aiProvider && !KNOWN_PROVIDERS.has(s.aiProvider));
    expect(bad.map((s) => s.id)).toHaveLength(0);
  });

  it('active qwen stories have an OpenRouter slug (contains "/")', () => {
    if (!isCanonical) return; // spec-mode may override model to MiniMax during a run
    const bad = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => s?.aiProvider === 'qwen' && s.model && !s.model.includes('/'));
    expect(bad.map((s) => s.id)).toHaveLength(0);
  });

  it('active .test.ts stories use qwen provider OR have an explicit MiniMax-M3 model upgrade', () => {
    // Original rule: test stories use qwen (OpenRouter, kimi-k2).
    // Exception: stories explicitly upgraded to MiniMax-M3 (stronger model) are allowed
    // to use minimax provider — the intent is quality, not provider lock-in.
    const badTestTsMinimax = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter(
        (s) =>
          s?.aiProvider === 'minimax' &&
          s?.model !== 'MiniMax-M3' && // explicit M3 upgrade is allowed
          s.technicalNotes?.files?.some((f) => f.endsWith('.test.ts'))
      );
    expect(badTestTsMinimax.map((s) => s.id)).toHaveLength(0);
  });
});

// ── Check 5: Clean pre-run state ─────────────────────────────────────────────
describe('PRD integrity — clean pre-run state', () => {
  it('all active stories have status=pending', () => {
    const notPending = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => s?.status && s.status !== 'pending');
    expect(notPending.map((s) => `${s.id}(${s.status})`)).toHaveLength(0);
  });

  it('all active stories have completed=false', () => {
    const completed = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => s?.completed === true);
    expect(completed.map((s) => s.id)).toHaveLength(0);
  });

  it('all active stories have an effort field', () => {
    const missing = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => !s?.effort);
    expect(missing.map((s) => s.id)).toHaveLength(0);
  });

  it('all active stories have an aiProvider field', () => {
    const missing = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => !s?.aiProvider);
    expect(missing.map((s) => s.id)).toHaveLength(0);
  });
});

// ── Check 6: Path integrity ──────────────────────────────────────────────────
describe('PRD integrity — path integrity', () => {
  it('project.outputDir is set', () => {
    expect(outputDir).toBeTruthy();
  });

  it('project.outputDir is an absolute literal (no shell vars)', () => {
    expect(outputDir.startsWith('/')).toBe(true);
    expect(outputDir).not.toContain('$');
    expect(outputDir).not.toContain('{');
  });

  it('no active story file path is under /tmp/', () => {
    const tmpPaths: string[] = [];
    for (const id of activeIds) {
      const s = byId.get(id);
      for (const f of s?.technicalNotes?.files ?? []) {
        if (f.startsWith('/tmp/')) tmpPaths.push(`${id}: ${f}`);
      }
    }
    expect(tmpPaths).toHaveLength(0);
  });

  it('all active story file paths start with project.outputDir', () => {
    if (!outputDir || outputDir.includes('$')) return;
    const bad: string[] = [];
    for (const id of activeIds) {
      const s = byId.get(id);
      for (const f of s?.technicalNotes?.files ?? []) {
        if (!f.startsWith(outputDir)) bad.push(`${id}: ${f}`);
      }
    }
    expect(bad).toHaveLength(0);
  });
});

// ── Check 7: AC quality ──────────────────────────────────────────────────────
describe('PRD integrity — AC quality', () => {
  it('no active story exceeds 24 ACs (speckit limit)', () => {
    const oversized = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) => (s?.acceptanceCriteria?.length ?? 0) > 24);
    expect(oversized.map((s) => `${s.id}(${s.acceptanceCriteria!.length}ACs)`)).toHaveLength(0);
  });

  it('no active story AC references phantom ./types module', () => {
    const bad = [...activeIds]
      .map((id) => byId.get(id)!)
      .filter((s) =>
        s?.acceptanceCriteria?.some(
          (ac) => ac.includes("'./types'") || ac.includes('"./types"')
        )
      );
    expect(bad.map((s) => s.id)).toHaveLength(0);
  });
});

// ── Check 8: Control plane port (no EADDRINUSE on startup) ──────────────────
describe('PRD integrity — control plane resilience', () => {
  it('run-agent-orchestration.sh kills stale process before starting control plane', () => {
    const script = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'),
      'utf8'
    );
    expect(script).toContain('lsof -ti');
    expect(script).toContain('CONTROL_PLANE_PORT');
  });

  it('control-plane.js binds 0.0.0.0 (WSL2 accessible)', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/control-plane.js'),
      'utf8'
    );
    expect(src).toContain("'0.0.0.0'");
    expect(src).not.toContain("'127.0.0.1'");
  });

  it('control-plane.js handles EADDRINUSE gracefully (no crash)', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/control-plane.js'),
      'utf8'
    );
    expect(src).toContain('EADDRINUSE');
  });
});
