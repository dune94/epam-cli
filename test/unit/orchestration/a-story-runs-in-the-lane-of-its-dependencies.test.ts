/**
 * A STORY RUNS IN THE LANE OF ITS DEPENDENCIES, AND A LANE'S STORIES ARE ITS OWN.
 *
 * regintel PRD on mockserver (£0 rehearsal #16, 2026-09-20): the topology heuristic put REGI-007
 * and REGI-008 in the primary lane (a worktree that runs after the main lane), while REGI-010 —
 * which depends on REGI-007 — stayed in the main lane. Step 8 reached REGI-010 first, its
 * dependency was unmet, and it was skipped for the phase. The tail sweep then mistook the two
 * primary-lane stories for split children and ran them on main; the primary worktree ran empty;
 * Step 17 refused to merge a branch with no commits; the phase failed with every story green.
 *
 * (1) Lane assignment honours dependencies: a story joins the lane of the story it depends on,
 * transitively, before each lane is sorted. (2) The tail sweep picks up only stories no lane
 * owns. (3) A story the first pass skipped for an unmet dependency is tried again once the pass
 * has completed more stories — deferred, not dropped. (4) A lane whose branch has no new commits
 * because every story it was given is already completed is a no-op, not a failed merge.
 * Executed with the real functions and a PRD fixture in the live shape.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/prd-integrity.sh');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PRD = { implementationOrder: { core: ['REGI-002', 'REGI-003', 'REGI-004', 'REGI-005', 'REGI-006', 'REGI-007', 'REGI-008', 'REGI-009', 'REGI-010'] }, stories: [
  { id: 'REGI-002', agentGroup: 'main', dependencies: [] },
  { id: 'REGI-005', agentGroup: 'main', dependencies: ['REGI-002'] },
  { id: 'REGI-006', agentGroup: 'main', dependencies: ['REGI-005'] },
  { id: 'REGI-007', agentGroup: 'primary', dependencies: ['REGI-005'] },
  { id: 'REGI-008', agentGroup: 'primary', dependencies: ['REGI-007'] },
  { id: 'REGI-009', agentGroup: 'main', dependencies: ['REGI-005'] },
  { id: 'REGI-010', agentGroup: 'main', dependencies: ['REGI-007', 'REGI-009'] },
] };
function prdFile() { const d = mkdtempSync(join(tmpdir(), 'lanes-')); dirs.push(d); const p = join(d, 'prd.json'); writeFileSync(p, JSON.stringify(PRD)); return p; }
function sh(cmd: string, prd: string) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; PRD_FILE=${JSON.stringify(prd)}; ${cmd}`], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

describe('(1) lane_dependency_closure — a dependent joins its dependency\'s lane', () => {
  it('REGI-010 (main, depends on primary REGI-007) moves to the primary lane', () => {
    const out = sh(`lane_dependency_closure "REGI-002
REGI-005
REGI-006
REGI-009
REGI-010" "REGI-007
REGI-008" ""`, prdFile());
    const [main, primary] = out.split('\n---\n');
    expect(primary.split('\n').filter(Boolean)).toEqual(expect.arrayContaining(['REGI-007', 'REGI-008', 'REGI-010']));
    expect(main.split('\n').filter(Boolean)).not.toContain('REGI-010');
    expect(main.split('\n').filter(Boolean)).toEqual(expect.arrayContaining(['REGI-002', 'REGI-005', 'REGI-006', 'REGI-009']));
  });
  it('a dependency on a MAIN story is satisfied before the lanes run — the dependent stays where it is', () => {
    const out = sh(`lane_dependency_closure "REGI-002
REGI-005" "REGI-007" ""`, prdFile());
    const [main, primary] = out.split('\n---\n');
    expect(primary.trim()).toBe('REGI-007');
    expect(main.split('\n').filter(Boolean)).toEqual(['REGI-002', 'REGI-005']);
  });
  it('is transitive and says what it moved', () => {
    const out = sh(`lane_dependency_closure "REGI-010" "REGI-007" "" 2>&1`, prdFile());
    expect(out).toMatch(/REGI-010.*(joins|moved|→).*primary/i);
  });
  it('the orchestrator applies it before the per-lane sort', () => {
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('lane_dependency_closure "$main_stories" "$primary_stories" "$independent_stories"');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(src.indexOf('main_stories=$(topo_sort_stories "$main_stories")'));
  });
});

describe('(2) the tail sweep picks up only stories no lane owns', () => {
  it('excludes the primary and independent lanes\' stories', () => {
    const out = sh(`tail_sweep_candidates core "REGI-002
REGI-005" "REGI-007
REGI-008" ""`, prdFile());
    const picked = out.split('\n').filter(Boolean);
    expect(picked).not.toContain('REGI-007'); expect(picked).not.toContain('REGI-008');
    expect(picked).toEqual(expect.arrayContaining(['REGI-006', 'REGI-009', 'REGI-010']));
    expect(picked).not.toContain('REGI-002');
  });
  it('the orchestrator uses it', () => {
    expect(readFileSync(ORCH, 'utf8')).toMatch(/tail_sweep_candidates "\$PHASE" "\$non_review_main" "\$primary_stories" "\$independent_stories"/);
  });
});

describe('(3) a story skipped for an unmet dependency is deferred, not dropped', () => {
  it('deferred_dependency_pass re-runs a pending story whose dependencies completed later in the pass', () => {
    const p = prdFile();
    // After the first pass: 007 completed (by the sweep), 009 completed, 010 still pending.
    const prd = JSON.parse(readFileSync(p, 'utf8'));
    for (const s of prd.stories) if (['REGI-002', 'REGI-005', 'REGI-006', 'REGI-007', 'REGI-009'].includes(s.id)) { s.completed = true; s.status = 'completed'; }
    writeFileSync(p, JSON.stringify(prd));
    const out = sh([
      `SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`,
      `log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }`,
      `_run_one_main_story(){ echo "RAN:$1"; }`,
      `deferred_dependency_pass core "REGI-002
REGI-005
REGI-006
REGI-009
REGI-010"`,
    ].join('\n'), p);
    expect(out).toMatch(/RAN:REGI-010/);
    expect(out).not.toMatch(/RAN:REGI-009/);
  });
  it('a story whose dependency is still unmet is left, with the reason', () => {
    const p = prdFile();
    const prd = JSON.parse(readFileSync(p, 'utf8'));
    for (const s of prd.stories) if (['REGI-002', 'REGI-005', 'REGI-009'].includes(s.id)) { s.completed = true; s.status = 'completed'; }
    writeFileSync(p, JSON.stringify(prd));
    const out = sh([`SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`, `log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }`, `_run_one_main_story(){ echo "RAN:$1"; }`, `deferred_dependency_pass core "REGI-010"`].join('\n'), p);
    expect(out).not.toMatch(/RAN:REGI-010/);
    expect(out).toMatch(/REGI-010[^\n]*REGI-007/);
  });
  it('the orchestrator runs the deferred pass after the tail sweep', () => {
    const src = readFileSync(ORCH, 'utf8');
    const iSweep = src.indexOf('[tail-sweep] Picking up');
    const iDeferred = src.indexOf('deferred_dependency_pass "$PHASE" "$non_review_main"');
    expect(iDeferred).toBeGreaterThan(iSweep);
  });
});

describe('(4) an empty lane is a no-op, not a failed merge', () => {
  it('a branch with no new commits whose stories are all completed is skipped with a log line', () => {
    const src = readFileSync(ORCH, 'utf8');
    const at = src.indexOf('has no new commits');
    const block = src.slice(at - 1200, at + 400);
    expect(block).toMatch(/lane_stories_all_completed/);
  });
  it('lane_stories_all_completed answers from the PRD', () => {
    const p = prdFile();
    const prd = JSON.parse(readFileSync(p, 'utf8'));
    for (const s of prd.stories) if (['REGI-007', 'REGI-008'].includes(s.id)) { s.completed = true; }
    writeFileSync(p, JSON.stringify(prd));
    expect(sh(`lane_stories_all_completed "REGI-007
REGI-008" && echo YES || echo NO`, p)).toContain('YES');
    expect(sh(`lane_stories_all_completed "REGI-007
REGI-010" && echo YES || echo NO`, p)).toContain('NO');
  });
});

describe('(5) a lane move is written to the PRD — the worktree agent reads agentGroup, not the orchestrator\'s list', () => {
  // £0 rehearsal #19: REGI-010 joined the primary lane in the orchestrator, but claude.sh
  // --worktree primary filters the phase's stories by the PRD's agentGroup, so the lane ran
  // REGI-007 and REGI-008 only and REGI-010 never ran anywhere.
  it('persist_lane_assignments sets agentGroup for every story in the primary and independent lists', () => {
    const p = prdFile();
    sh(`persist_lane_assignments "REGI-007
REGI-008
REGI-010" ""`, p);
    const prd = JSON.parse(readFileSync(p, 'utf8'));
    const g = (id: string) => prd.stories.find((s: any) => s.id === id).agentGroup;
    expect(g('REGI-010')).toBe('primary'); expect(g('REGI-007')).toBe('primary'); expect(g('REGI-009')).toBe('main');
  });
  it('the orchestrator persists right after the closure', () => {
    const src = readFileSync(ORCH, 'utf8');
    const iClosure = src.indexOf('lane_dependency_closure "$main_stories"');
    const iPersist = src.indexOf('persist_lane_assignments "$primary_stories" "$independent_stories"');
    expect(iPersist).toBeGreaterThan(iClosure);
    expect(iPersist).toBeLessThan(src.indexOf('main_stories=$(topo_sort_stories "$main_stories")'));
  });
});
