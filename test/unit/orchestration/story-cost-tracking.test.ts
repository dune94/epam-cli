/**
 * Estimates-vs-Actuals contract for user stories.
 *
 * Every active story MUST have an estimatedCost in the PRD. After a story
 * agent completes, its actualCost MUST be written back to prd.json so that
 * estimated vs actual comparisons can be made per-story and per-phase.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT  = path.resolve(__dirname, '../../../');
// Use the canonical PRD for cost/schema checks — the runtime travel-app-prd.json
// is overwritten by the Jira ingest step on every brownfield run and does not
// carry estimatedCost fields.
const PRD_FILE   = path.join(REPO_ROOT, 'orchestrations/travel-app-prd.canonical.json');
const ORCH_SCRIPT = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const GATE_LIB   = path.join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const REMEDIATE  = path.join(REPO_ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');
const TIER3      = path.join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');

const prd        = JSON.parse(fs.readFileSync(PRD_FILE, 'utf8'));
const orchSrc    = fs.readFileSync(ORCH_SCRIPT, 'utf8');
// record_story_actual_cost now lives in lib/story-guards.sh (2026-07-14) —
// a single shared implementation sourced by both run-agent-orchestration.sh
// (main lane) and claude.sh (worktree lanes), so every lane's actualCost
// write-back is identical.
const guardsSrc  = fs.readFileSync(GATE_LIB, 'utf8');
const remSrc     = fs.readFileSync(REMEDIATE, 'utf8');

const implOrder  = prd.implementationOrder as Record<string, string[]>;
const activeIds  = new Set(Object.values(implOrder).flat());
const stories    = (prd.stories as any[]).filter(s => activeIds.has(s.id));
const byId       = Object.fromEntries((prd.stories as any[]).map(s => [s.id, s]));
const isCanonical = (prd.stories as any[]).every((s: any) => !s?.specification?.createdFrom || s?.specification?.splitOrigin === 'spec-pass');

// ── PRD schema ────────────────────────────────────────────────────────────────

describe('PRD schema — cost fields', () => {
  it('every active story has a numeric estimatedCost', () => {
    const missing = stories.filter(s => typeof s.estimatedCost !== 'number' || s.estimatedCost <= 0);
    expect(missing.map(s => s.id)).toEqual([]);
  });

  it('estimatedCost field is present on all active stories', () => {
    for (const s of stories) {
      expect(s).toHaveProperty('estimatedCost');
    }
  });

  it('actualCost field exists on all active stories (null until agent runs)', () => {
    if (isCanonical) return; // actualCost is written by run-agent-orchestration.sh post-execution
    for (const s of stories) {
      expect(Object.prototype.hasOwnProperty.call(s, 'actualCost')).toBe(true);
    }
  });

  it('no active story has a negative estimatedCost', () => {
    const bad = stories.filter(s => typeof s.estimatedCost === 'number' && s.estimatedCost < 0);
    expect(bad.map(s => s.id)).toEqual([]);
  });

  it('total estimated cost across all active stories is non-zero', () => {
    if (stories.length === 0) return; // valid pre-launch state (brownfield sentinel)
    const total = stories.reduce((sum, s) => sum + (s.estimatedCost || 0), 0);
    expect(total).toBeGreaterThan(0);
  });

  it('estimatedTokens field is present on all active stories', () => {
    const missing = stories.filter(s => !s.estimatedTokens || s.estimatedTokens <= 0);
    expect(missing.map(s => s.id)).toEqual([]);
  });
});

// ── Per-phase estimates summary ───────────────────────────────────────────────

describe('Per-phase estimated cost', () => {
  const phases = Object.entries(implOrder);
  if (phases.length === 0) {
    it('skipped — PRD is empty (brownfield pre-launch sentinel)', () => {});
  } else {
    for (const [phase, ids] of phases) {
      it(`phase "${phase}" has a positive total estimatedCost`, () => {
        const total = (ids as string[]).reduce((sum, id) => {
          const s = byId[id];
          return sum + (s?.estimatedCost || 0);
        }, 0);
        expect(total).toBeGreaterThan(0);
      });
    }
  }
});

// ── record_story_actual_cost mechanism ───────────────────────────────────────

describe('record_story_actual_cost — shared lib implementation (lib/story-guards.sh)', () => {
  it('function record_story_actual_cost exists in the shared lib', () => {
    expect(guardsSrc).toMatch(/^record_story_actual_cost\(\)/m);
  });

  it('run-agent-orchestration.sh and claude.sh both source the shared lib', () => {
    expect(orchSrc).toContain('source "$SCRIPT_DIR/lib/story-guards.sh"');
    const claudeSrc = fs.readFileSync(path.join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(claudeSrc).toContain('source "$SCRIPT_DIR/lib/story-guards.sh"');
  });

  it('extracts cost_usd from story log file', () => {
    expect(guardsSrc).toMatch(/cost_usd.*log_file|grep.*cost_usd.*log/);
  });

  it('falls back to phase-cost.jsonl when log has no cost', () => {
    expect(guardsSrc).toMatch(/PHASE_COST_FILE.*phase-cost\.jsonl|phase-cost\.jsonl.*PHASE_COST_FILE/);
    // The function must sum task_cost_usd records for the story from the cost file
    expect(guardsSrc).toMatch(/task_cost_usd.*story_id|story_id.*task_cost_usd/);
  });

  it('writes actualCost back to prd.json via jq', () => {
    expect(guardsSrc).toMatch(/\.actualCost\s*=\s*\$cost/);
    // Must target the specific story by id
    expect(guardsSrc).toMatch(/select\(\.id\s*==\s*\$sid\)/);
  });

  it('is called after every main-lane story completes', () => {
    // Must appear after run_story_with_watchdog in the main loop (allowing
    // room for the watchdog-timeout recovery block in between)
    const mainLoopIdx = orchSrc.indexOf('run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log"');
    expect(mainLoopIdx).toBeGreaterThan(-1);
    const after = orchSrc.slice(mainLoopIdx, mainLoopIdx + 900);
    expect(after).toMatch(/record_story_actual_cost "\$story"/);
  });

  it('is called after every review-lane story completes', () => {
    const reviewLoopIdx = orchSrc.indexOf('run_story_with_watchdog "$story" "$LOG_DIR/review-${story}.log"');
    expect(reviewLoopIdx).toBeGreaterThan(-1);
    const after = orchSrc.slice(reviewLoopIdx, reviewLoopIdx + 200);
    expect(after).toMatch(/record_story_actual_cost "\$story"/);
  });

  it('is called after every worktree-lane story completes too (parity fix, 2026-07-14)', () => {
    const claudeSrc = fs.readFileSync(path.join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(claudeSrc).toContain('record_story_actual_cost "$story_id"');
  });

  it('uses atomic write (tmp + mv) to avoid partial-write corruption of prd.json', () => {
    const fnStart = guardsSrc.indexOf('record_story_actual_cost()');
    const fnEnd   = guardsSrc.indexOf('\n}', fnStart) + 2;
    const fnBody  = guardsSrc.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/mktemp/);
    expect(fnBody).toMatch(/mv "\$tmp"/);
  });

  it('is a no-op when no log file is given/exists (no crash) — falls back to phase-cost.jsonl instead of early-returning', () => {
    // Relocated (2026-07-14): log_file is now OPTIONAL (worktree lanes run
    // implement_story in-process, with no per-story log file to grep) — the
    // function no longer hard-requires [ -f "$log_file" ] and instead falls
    // through to the phase-cost.jsonl aggregation. See the lib's docstring.
    const fnStart = guardsSrc.indexOf('record_story_actual_cost()');
    const fnEnd   = guardsSrc.indexOf('\n}', fnStart) + 2;
    const fnBody  = guardsSrc.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/local log_file="\$\{2:-\}"/);
    expect(fnBody).toMatch(/if \[ -n "\$log_file" \] && \[ -f "\$log_file" \]; then/);
  });
});

// ── prd-remediate must NOT strip actualCost ───────────────────────────────────

describe('prd-remediate — actualCost preservation', () => {
  it('RUNTIME_FIELDS does NOT include actualCost', () => {
    // actualCost is historical — must survive remediation
    const runtimeFieldsLine = remSrc.match(/RUNTIME_FIELDS\s*=\s*\[([^\]]+)\]/)?.[1] ?? '';
    expect(runtimeFieldsLine).not.toMatch(/actualCost/);
  });

  it('has an explicit comment explaining why actualCost is preserved', () => {
    expect(remSrc).toMatch(/actualCost.*preserved|preserved.*actualCost/i);
  });

  it('still strips startedAt, completedAt, error, agentLog', () => {
    expect(remSrc).toMatch(/startedAt/);
    expect(remSrc).toMatch(/completedAt/);
    expect(remSrc).toMatch(/agentLog/);
  });
});

// ── Variance reporting ────────────────────────────────────────────────────────

describe('Estimates-vs-actuals variance', () => {
  it('orch script contains variance/forecast cost reporting block', () => {
    expect(orchSrc).toMatch(/variance_cost_usd|forecast_cost_usd|actual_cost_usd/);
  });

  it('phase-level cost budget check references actualCost or actual_cost', () => {
    expect(orchSrc).toMatch(/actualCost|actual_cost/);
  });

  it('all active stories have estimatedCost as a positive float', () => {
    for (const s of stories) {
      expect(typeof s.estimatedCost).toBe('number');
      expect(s.estimatedCost).toBeGreaterThan(0);
    }
  });
});
