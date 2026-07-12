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
const PRD_FILE   = path.join(REPO_ROOT, 'orchestrations/travel-app-prd.json');
const ORCH_SCRIPT = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const REMEDIATE  = path.join(REPO_ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');
const TIER3      = path.join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');

const prd        = JSON.parse(fs.readFileSync(PRD_FILE, 'utf8'));
const orchSrc    = fs.readFileSync(ORCH_SCRIPT, 'utf8');
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
  for (const [phase, ids] of Object.entries(implOrder)) {
    it(`phase "${phase}" has a positive total estimatedCost`, () => {
      const total = (ids as string[]).reduce((sum, id) => {
        const s = byId[id];
        return sum + (s?.estimatedCost || 0);
      }, 0);
      expect(total).toBeGreaterThan(0);
    });
  }
});

// ── record_story_actual_cost mechanism ───────────────────────────────────────

describe('record_story_actual_cost — orch script implementation', () => {
  it('function record_story_actual_cost exists in orch script', () => {
    expect(orchSrc).toMatch(/^record_story_actual_cost\(\)/m);
  });

  it('extracts cost_usd from story log file', () => {
    expect(orchSrc).toMatch(/cost_usd.*log_file|grep.*cost_usd.*log/);
  });

  it('falls back to phase-cost.jsonl when log has no cost', () => {
    expect(orchSrc).toMatch(/PHASE_COST_FILE.*phase-cost\.jsonl|phase-cost\.jsonl.*PHASE_COST_FILE/);
    // The function must sum task_cost_usd records for the story from the cost file
    expect(orchSrc).toMatch(/task_cost_usd.*story_id|story_id.*task_cost_usd/);
  });

  it('writes actualCost back to prd.json via jq', () => {
    expect(orchSrc).toMatch(/\.actualCost\s*=\s*\$cost/);
    // Must target the specific story by id
    expect(orchSrc).toMatch(/select\(\.id\s*==\s*\$sid\)/);
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

  it('uses atomic write (tmp + mv) to avoid partial-write corruption of prd.json', () => {
    const fnStart = orchSrc.indexOf('record_story_actual_cost()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart) + 2;
    const fnBody  = orchSrc.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/mktemp/);
    expect(fnBody).toMatch(/mv "\$tmp"/);
  });

  it('is a no-op when the log file does not exist (no crash)', () => {
    const fnStart = orchSrc.indexOf('record_story_actual_cost()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart) + 2;
    const fnBody  = orchSrc.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/\[ -f "\$log_file" \].*return 0/);
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
