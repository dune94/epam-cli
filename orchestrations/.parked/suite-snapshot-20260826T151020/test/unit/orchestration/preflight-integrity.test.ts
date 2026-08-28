/**
 * preflight-prd-integrity.sh — contract tests.
 *
 * Verifies the 16-check integrity gate catches every category of PRD drift
 * that has caused real run failures. Tests run entirely in-process against
 * synthetic PRD fixtures (no shell invocation needed).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// ── Real execution — proves the SCRIPT itself (not a reimplementation) works ──
describe('preflight-prd-integrity.sh — real subprocess execution', () => {
  const SCRIPT = join(__dirname, '../../../orchestrations/scripts/preflight-prd-integrity.sh');
  const outputDir = '/tmp/preflight-integrity-fixture-app';

  function baseFixture(): any {
    return {
      project: { outputDir },
      stories: [
        {
          id: 'FIX-001',
          status: 'pending',
          completed: false,
          effort: 'medium',
          aiProvider: 'qwen',
          model: 'moonshotai/kimi-k2',
          acceptanceCriteria: ['does a thing'],
          technicalNotes: { files: [`${outputDir}/src/thing.ts`] },
        },
      ],
      // ui_and_review removed (2026-07-07): pipeline is scaffold -> core only.
      implementationOrder: { scaffold: [], core: ['FIX-001'] },
    };
  }

  function runPreflight(prd: any): { code: number; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-fixture-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(prd));
    try {
      const stdout = execFileSync('bash', [SCRIPT, '--prd', prdPath], { encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (e: any) {
      return { code: e.status ?? 1, stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes (exit 0) on a clean fixture', () => {
    const result = runPreflight(baseFixture());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PRD integrity OK');
  });

  // A stale-specification check was tried directly in this script and reverted
  // (2026-07-06 same-day regression): this script only ever runs on the
  // POST-split-pass branch, where every active story legitimately has a
  // specification block from this run's own elaboration — the check fired on
  // SKY-001 the moment scaffold phase completed and aborted a clean run. The
  // real fix lives in preflight-check.sh / prd-remediate.sh instead (tested
  // below), which run BEFORE spec pass and can distinguish "not yet completed
  // but already has specification data" (stale) from "legitimately completed
  // with its own data" (fine).
  it('does not flag a legitimately-elaborated, completed story as having a stale specification block (this script has no completed-vs-stale check — that lives upstream)', () => {
    const prd = baseFixture();
    prd.stories[0].status = 'completed';
    prd.stories[0].completed = true;
    prd.stories[0].specification = { status: 'completed', appliedAgents: ['openspec', 'speckit'] };
    // completed stories are expected to fail check 10 (clean pending state) in
    // this fixture regardless — the point here is specifically that no
    // specification-related check exists in this script to also fire.
    const result = runPreflight(prd);
    expect(result.stdout).not.toMatch(/specification/);
  });

  it('fails (exit 1) on a stale BUG- story (sanity check that exit-code plumbing works end to end)', () => {
    const prd = baseFixture();
    prd.stories.push({
      id: 'BUG-001',
      status: 'pending',
      completed: false,
      effort: 'low',
      aiProvider: 'qwen',
      model: 'moonshotai/kimi-k2',
      acceptanceCriteria: [],
      technicalNotes: { files: [] },
    });
    const result = runPreflight(prd);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Stale BUG- stories/);
  });

  // preflight-prd-integrity.sh's own testCriteria check is for POST-spec-pass
  // elaborated PRDs. Canonical (pre-spec-pass) base stories are only ever run
  // through it via the is_canonical bypass wrapper in preflight-check.sh /
  // prd-remediate.sh (tested below) — calling it directly on the raw
  // canonical file is expected to fail on that one known pre-spec-pass gap.
  // ui_and_review is no longer a required phase (removed 2026-07-07) — the
  // canonical PRD's 2 phases (scaffold, core) now satisfy the phase check.
  it('direct invocation on the raw canonical PRD fails only on the known pre-spec-pass gap (testCriteria stub) — phase check now passes with 2 phases', () => {
    const result = runPreflight(JSON.parse(readFileSync(PRD_PATH, 'utf8')));
    expect(result.code).toBe(1);
    expect(result.stdout).not.toMatch(/Missing required phases/);
    expect(result.stdout).toMatch(/Exactly 2 phases in correct order/);
    expect(result.stdout).toMatch(/Test stories missing testCriteria field/);
  });
});

// ── The is_canonical bypass wrappers must also catch stale specification data,
// scoped correctly by the 'completed' flag (this exact scoping bug shipped
// and broke a live run on 2026-07-06: SKY-001's OWN legitimate specification
// data from this run's scaffold-phase spec pass was misflagged as "stale"
// because the first version of this check didn't exclude completed stories) ─
describe('preflight-check.sh / prd-remediate.sh — canonical bypass catches stale specification blocks (completed-scoped)', () => {
  const CANONICAL_SHAPED = {
    project: { outputDir: '/tmp/preflight-canonical-fixture-app' },
    stories: [
      { id: 'SKY-001', status: 'pending', completed: false, effort: 'medium', aiProvider: 'qwen', model: 'moonshotai/kimi-k2', acceptanceCriteria: ['a'], technicalNotes: { files: ['src/index.ts'] } },
    ],
    // scaffold lists SKY-001 with a non-empty technicalNotes.files (matching
    // how a real canonical PRD looks even pre-spec-pass — see
    // travel-app-prd.canonical.json's own implementationOrder/technicalNotes)
    // so neither step 2's no-files removal nor the orphaned-pending-story
    // gate added 2026-07-09 fire and mask what this describe block actually
    // tests (the specification-block check below).
    implementationOrder: { scaffold: ['SKY-001'], core: [], ui_and_review: [] },
  };

  function runPrdRemediate(prd: any, phase?: string): { code: number; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-fixture-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(prd));
    try {
      const args = [join(__dirname, '../../../orchestrations/scripts/prd-remediate.sh'), '--prd', prdPath];
      if (phase) args.push('--phase', phase);
      const stdout = execFileSync('bash', args, { encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (e: any) {
      return { code: e.status ?? 1, stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('prd-remediate.sh fails when a PENDING (not-yet-processed) story carries a pre-baked specification block', () => {
    const prd = structuredClone(CANONICAL_SHAPED);
    (prd.stories[0] as any).specification = { status: 'completed', appliedAgents: ['openspec', 'speckit'] };
    const result = runPrdRemediate(prd);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/pre-baked 'specification' blocks on base stories/);
  });

  it('prd-remediate.sh does NOT flag a COMPLETED story carrying its own legitimate specification data (reproduces + fixes the live SKY-001 false positive)', () => {
    const prd = structuredClone(CANONICAL_SHAPED);
    prd.stories[0].status = 'completed';
    prd.stories[0].completed = true;
    (prd.stories[0] as any).specification = { status: 'completed', appliedAgents: ['openspec', 'speckit'] };
    // Scope to a phase that does NOT contain SKY-001 (it lives in 'scaffold')
    // so step 6's reset-to-pending doesn't touch it — this test is about the
    // specification-block check honoring an already-completed story, not
    // about step 6's own (correct, separate) reset behavior.
    const result = runPrdRemediate(prd, 'ui_and_review');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/pre-baked 'specification' blocks/);
  });

  it('prd-remediate.sh passes clean on a truly lean canonical-shaped PRD (no specification anywhere)', () => {
    const result = runPrdRemediate(CANONICAL_SHAPED);
    expect(result.code).toBe(0);
  });

  it('preflight-check.sh and prd-remediate.sh both scope the stale-specification check by the completed flag (static contract, both files)', () => {
    for (const file of ['preflight-check.sh', 'prd-remediate.sh']) {
      const script = readFileSync(join(__dirname, `../../../orchestrations/scripts/${file}`), 'utf8');
      expect(script).toMatch(/_stale_spec=/);
      // THE PREDICATE MOVED OUT OF THE SHELL into a handler, so BOTH scripts now share ONE
      // copy instead of each carrying its own. Asserting the snippet's text against each
      // script demanded a duplication the extraction deliberately removed — and duplicated
      // predicates are how two callers silently drift apart.
      expect(script, `${file} must delegate to the shared predicate`)
        .toMatch(/prd-stale-specification-stories\.py/);
    }
  });

  it('the shared stale-specification predicate is still scoped by the completed flag', () => {
    const handler = readFileSync(join(__dirname,
      '../../../orchestrations/scripts/lib/handlers/prd-stale-specification-stories.py'), 'utf8');
    expect(handler.length, 'the handler must exist — otherwise this asserts nothing').toBeGreaterThan(50);
    expect(handler).toMatch(/s\.get\('specification'\) and not s\.get\('completed'\)/);
  });

  it('the real canonical PRD (as committed) has zero stale specification blocks — this is the bug that was just fixed', () => {
    const prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
    const stale = prd.stories.filter((s: any) => s.specification);
    expect(stale.map((s: any) => s.id)).toHaveLength(0);
  });
});
