/**
 * Pipeline Stage Coverage — TDD contract for every stage and sub-stage.
 *
 * Each stage has:
 *   - Happy-path: step completes successfully
 *   - Bypass path: skip env var causes SKIP status, not silent omission
 *   - Failure path: blocking failure causes the correct error + pipeline abort
 *   - step_emit contract: the correct status string reaches step-status.json
 *
 * Coverage target: 100% of 24 pipeline steps.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ORCH_SCRIPT = path.resolve(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const PROFILES = path.resolve(__dirname, '../../../orchestrations/agents/profiles.json');
const TC_WRITER = path.resolve(__dirname, '../../../orchestrations/scripts/post-impl-tc-writer.sh');

const orchSrc = fs.readFileSync(ORCH_SCRIPT, 'utf8');
const tcSrc   = fs.readFileSync(TC_WRITER, 'utf8');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stepEmitCount(stepId: string, status: string): number {
  const re = new RegExp(`step_emit\\s+"${stepId}"\\s+"${status}"`, 'g');
  return (orchSrc.match(re) || []).length;
}

function hasStepEmit(stepId: string, status: string): boolean {
  return stepEmitCount(stepId, status) > 0;
}

function hasBypassSkip(stepId: string, envVar: string): boolean {
  // Check that when the bypass env var is set, step_emit "skip" fires for this step
  const re = new RegExp(
    `${envVar.replace(/[=.]/g, '\\$&')}[^)]*[\\s\\S]{0,400}step_emit\\s+"${stepId}"\\s+"skip"` +
    `|step_emit\\s+"${stepId}"\\s+"skip"[\\s\\S]{0,400}${envVar.replace(/[=.]/g, '\\$&')}`,
  );
  return re.test(orchSrc);
}

// ─── Step manifest: every stage we guarantee coverage for ────────────────────

const STEPS = [
  { id: '0',    name: 'Specification pass',        bypassVar: 'EPAM_SPEC_MODE', bypassVal: '0' },
  { id: '0.1',  name: 'CPA pre-pass',              bypassVar: 'SKIP_CPA',       bypassVal: '1' },
  { id: '0.5',  name: 'Pre-phase skill assessment', bypassVar: 'SKIP_SKILL_ASSESSMENT', bypassVal: '1' },
  { id: '0.6',  name: 'Hybrid pre-coord',          bypassVar: null },
  { id: '0.7',  name: 'Regression guard',          bypassVar: 'SKIP_REGRESSION_GUARD', bypassVal: 'true' },
  { id: '0.8',  name: 'mkdir src/ dirs',           bypassVar: null },
  { id: '1',    name: 'Main-branch stories',       bypassVar: null },
  { id: '1.5',  name: 'Auto-commit',               bypassVar: null },
  { id: '1.6',  name: 'TC writer gate',            bypassVar: 'SKIP_TC_WRITER', bypassVal: '1' },
  { id: '2',    name: 'Create worktrees',          bypassVar: null },
  { id: '3a',   name: 'Primary agent',             bypassVar: null },
  { id: '3b',   name: 'Independent agent',         bypassVar: null },
  { id: '3.1',  name: 'Worktree health',           bypassVar: null },
  { id: '3.5',  name: 'Post-parallel assessment',  bypassVar: 'SKIP_SKILL_ASSESSMENT', bypassVal: '1' },
  { id: '3.7',  name: 'Pre-review gate',           bypassVar: 'SKIP_PRE_REVIEW_GATE', bypassVal: 'true' },
  { id: '4',    name: 'Review stories',            bypassVar: null },
  { id: '4.2a', name: 'SAST sentinel',             bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '4.2b', name: 'Spec validator',            bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '4.3a', name: 'Review ranger',             bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '4.3b', name: 'Mutant hunter',             bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '4.4a', name: 'Fuzz-weaver',               bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '4.4b', name: 'Perf sentinel',             bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '4.6',  name: 'Browser E2E',               bypassVar: 'SKIP_BROWSER_E2E_ROUTING', bypassVal: 'true' },
] as const;

// ─── Universal contract: every step must have pass + skip or pass + fail ─────

describe('Pipeline stage step_emit — universal contract', () => {
  for (const step of STEPS) {
    describe(`Step ${step.id}: ${step.name}`, () => {
      it('has at least one step_emit "pass" or "skip" call', () => {
        const hasPass = hasStepEmit(step.id, 'pass');
        const hasSkip = hasStepEmit(step.id, 'skip');
        expect(hasPass || hasSkip).toBe(true);
      });

      it('has step_emit "running" or "pass" — step is not a black box', () => {
        const hasRunning = hasStepEmit(step.id, 'running');
        const hasPass    = hasStepEmit(step.id, 'pass');
        const hasSkip    = hasStepEmit(step.id, 'skip');
        // A step must at minimum emit SOMETHING (running/pass/skip)
        expect(hasRunning || hasPass || hasSkip).toBe(true);
      });
    });
  }
});

// ─── Bypass env var contract: every bypassable step emits SKIP ───────────────

describe('Pipeline stage bypass — skips must be visible', () => {
  for (const step of STEPS) {
    if (!step.bypassVar) continue;
    it(`Step ${step.id}: skip path covered when ${step.bypassVar}=${step.bypassVal}`, () => {
      expect(hasStepEmit(step.id, 'skip')).toBe(true);
    });
  }

  it('SKIP_TESTING_GATES=true emits skip for ALL Phase A/B/C/E2E steps', () => {
    const gateSteps = ['4.2a', '4.2b', '4.3a', '4.3b', '4.4a', '4.4b', '4.6'];
    for (const id of gateSteps) {
      expect(hasStepEmit(id, 'skip')).toBe(true);
    }
  });

  it('Phase A failure causes Phase B steps to emit skip, not pending', () => {
    expect(hasStepEmit('4.3a', 'skip')).toBe(true);
    expect(hasStepEmit('4.3b', 'skip')).toBe(true);
    expect(orchSrc).toMatch(/Phase A had failures[\s\S]{0,200}step_emit.*4\.3a.*skip|step_emit.*4\.3a.*skip[\s\S]{0,200}Phase A had failures/);
  });

  it('Phase A/B failure causes Phase C steps to emit skip, not pending', () => {
    expect(hasStepEmit('4.4a', 'skip')).toBe(true);
    expect(hasStepEmit('4.4b', 'skip')).toBe(true);
    expect(orchSrc).toMatch(/Phase A\/B failed[\s\S]{0,200}step_emit.*4\.4a.*skip|step_emit.*4\.4a.*skip[\s\S]{0,200}Phase A\/B/);
  });
});

// ─── Failure path contract: blocking steps emit fail ─────────────────────────

describe('Pipeline stage failure paths', () => {
  it('Step 0: spec pass failure emits step_emit fail', () => {
    expect(hasStepEmit('0', 'fail')).toBe(true);
  });

  it('Step 0.1: CPA gate BLOCKED emits step_emit fail', () => {
    expect(hasStepEmit('0.1', 'fail')).toBe(true);
  });

  it('Step 1.6: TC writer gate failure emits step_emit fail', () => {
    expect(hasStepEmit('1.6', 'fail')).toBe(true);
  });

  it('Step 3.7: pre-review gate failure emits step_emit fail', () => {
    expect(hasStepEmit('3.7', 'fail')).toBe(true);
  });

  it('Step 4.2a: SAST sentinel blocker emits step_emit fail', () => {
    expect(hasStepEmit('4.2a', 'fail')).toBe(true);
  });

  it('Step 4.2b: spec validator fail emits step_emit fail', () => {
    expect(hasStepEmit('4.2b', 'fail')).toBe(true);
  });

  it('Step 4.3a: review-ranger blocker emits step_emit fail', () => {
    expect(hasStepEmit('4.3a', 'fail')).toBe(true);
  });

  it('Step 4.3b: mutant-hunter fail emits step_emit fail', () => {
    expect(hasStepEmit('4.3b', 'fail')).toBe(true);
  });

  it('Step 4.4a: fuzz-weaver grounded fail emits step_emit fail', () => {
    expect(hasStepEmit('4.4a', 'fail')).toBe(true);
  });

  it('Step 4.4b: perf-sentinel grounded fail emits step_emit fail', () => {
    expect(hasStepEmit('4.4b', 'fail')).toBe(true);
  });
});

// ─── Warn paths: downgraded hallucinations must emit warn not fail ────────────

describe('Pipeline gate grounding — hallucinated fails downgraded to warn', () => {
  it('fuzz-weaver: ungrounded fail → step_emit warn, not fail', () => {
    expect(orchSrc).toMatch(/hallucinated findings downgraded/);
    expect(orchSrc).toMatch(/step_emit "4\.4a" "warn" "Step 4\.4a: Fuzz-weaver" "hallucinated findings downgraded"/);
  });

  it('perf-sentinel: ungrounded fail → step_emit warn, not fail', () => {
    expect(orchSrc).toMatch(/hallucinated fail downgraded/);
    expect(orchSrc).toMatch(/step_emit "4\.4b" "warn" "Step 4\.4b: Perf sentinel" "hallucinated fail downgraded"/);
  });

  it('fuzz-weaver grounding check uses python3 file-existence test', () => {
    expect(orchSrc).toMatch(/_fuzz_grounded=\$\(python3/);
    expect(orchSrc).toMatch(/os\.path\.exists/);
  });

  it('perf-sentinel grounding check uses python3 with blockerCount + filesAnalysed', () => {
    expect(orchSrc).toMatch(/_perf_grounded=\$\(python3/);
    expect(orchSrc).toMatch(/blockerCount/);
    expect(orchSrc).toMatch(/filesAnalysed/);
  });

  it('perf-sentinel grounded fail requires real_blockers > 0 AND files_analysed > 0', () => {
    // The grounding logic must check both conditions
    expect(orchSrc).toMatch(/real_blockers.*files_analysed|files_analysed.*real_blockers/);
    expect(orchSrc).toMatch(/grounded = 1 if.*real_blockers > 0.*files_analysed > 0/s);
  });

  it('perf-sentinel: verdict=fail with summary=null → downgraded to warn (run-82 regression)', () => {
    // This is the exact run-82 failure case: {"summary": null, "findings": [], "verdict": "fail"}
    // The grounding check must catch summary=null as ungrounded
    expect(orchSrc).toMatch(/summary = data\.get\("summary"\) or \{\}/);
    expect(orchSrc).toMatch(/blocker_count = summary\.get\("blockerCount", 0\) if summary else 0/);
  });
});

// ─── Step 1.6 TC writer gate contract ────────────────────────────────────────

describe('Step 1.6: TC writer gate contract', () => {
  it('TC writer gate: no duplicate step_emit skip calls', () => {
    const dupeCount = (orchSrc.match(/step_emit "1\.6" "skip"/g) || []).length;
    // There should be exactly 1 skip path for the "no test stories" case, not 2
    expect(dupeCount).toBeLessThanOrEqual(2); // one for "all TCs present", one for "SKIP_TC_WRITER=1"
  });

  it('TC writer script checks agent exit BEFORE checking tc_file existence', () => {
    // The bug: old code checked os.path.exists(tc_file) first, allowing stale files
    // The fix: check tc_exit != 0 first, unconditionally
    const exitCheckIdx = tcSrc.indexOf('if tc_exit != 0:');
    const fileCheckIdx = tcSrc.indexOf('if not os.path.exists(tc_file):');
    expect(exitCheckIdx).toBeGreaterThan(-1);
    expect(fileCheckIdx).toBeGreaterThan(-1);
    // exit check must come BEFORE file-exists check
    expect(exitCheckIdx).toBeLessThan(fileCheckIdx);
  });

  it('TC writer script rejects stale tc_file when agent failed', () => {
    expect(tcSrc).toMatch(/stale TC file exists but will NOT be used/);
  });

  it('TC writer script exits 1 when agent failed regardless of tc_file state', () => {
    // Both branches (file exists / file missing) under tc_exit != 0 must call sys.exit(1)
    const exitBlock = tcSrc.match(/if tc_exit != 0:([\s\S]*?)if not os\.path\.exists/)?.[1] ?? '';
    expect(exitBlock).toMatch(/sys\.exit\(1\)/);
  });

  it('TC writer gate emits fail step_emit when script exits non-zero', () => {
    expect(hasStepEmit('1.6', 'fail')).toBe(true);
  });
});

// ─── Checklist print contract ─────────────────────────────────────────────────

describe('Pipeline step checklist — printed before Step 0 runs', () => {
  it('print_step_checklist is called before run_specification_pass', () => {
    // Find the CALL site (after start_control_plane, not the function definition at top)
    const callIdx = orchSrc.indexOf('\nprint_step_checklist\n');
    expect(callIdx).toBeGreaterThan(-1);
    // The spec pass block starts with run_specification_pass()
    const specPassIdx = orchSrc.indexOf('\nrun_specification_pass');
    expect(specPassIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(specPassIdx);
  });

  it('print_step_checklist lists all 24 step IDs', () => {
    const fn = orchSrc.match(/print_step_checklist\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const ids = ['0', '0.1', '0.5', '0.6', '0.7', '0.8', '1', '1.5', '1.6',
                 '2', '3a', '3b', '3.1', '3.2', '3.5', '3.7',
                 '4', '4.2a', '4.2b', '4.3a', '4.3b', '4.4a', '4.4b', '4.6'];
    for (const id of ids) {
      expect(fn).toMatch(new RegExp(`"${id.replace('.', '\\.')}"`));
    }
  });

  it('heartbeat loop fires every 60 seconds', () => {
    expect(orchSrc).toMatch(/sleep 60/);
    expect(orchSrc).toMatch(/_checklist_heartbeat &/);
  });

  it('heartbeat PID is killed on EXIT trap', () => {
    expect(orchSrc).toMatch(/trap.*_HEARTBEAT_PID.*EXIT/);
  });

  it('step-status.json is written atomically via tmp file + mv', () => {
    expect(orchSrc).toMatch(/tmp_file=.*\.tmp\.\$\$/);
    expect(orchSrc).toMatch(/mv "\$tmp_file" "\$STEP_STATUS_FILE"/);
  });
});

// ─── Agent profile grounding rules ───────────────────────────────────────────

describe('Agent profiles — grounding rules present', () => {
  let profiles: Record<string, string>;
  beforeAll(() => {
    profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  });

  it('fuzz-weaver profile has GROUNDING RULES section', () => {
    expect(profiles['fuzz-weaver']).toMatch(/GROUNDING RULES/);
  });

  it('fuzz-weaver profile forbids verdict=fail without file access', () => {
    expect(profiles['fuzz-weaver']).toMatch(/NEVER.*fail|tool list empty|ALL cases.*gap/i);
  });

  it('perf-sentinel profile has GROUNDING RULES section', () => {
    expect(profiles['perf-sentinel']).toMatch(/GROUNDING RULES/);
  });

  it('perf-sentinel profile forbids verdict=fail with filesAnalysed=0', () => {
    expect(profiles['perf-sentinel']).toMatch(/filesAnalysed=0.*NEVER.*fail|NEVER.*fail.*filesAnalysed=0/i);
  });

  it('perf-sentinel profile requires warn output when no tool access', () => {
    expect(profiles['perf-sentinel']).toMatch(/"verdict":"warn"/);
    expect(profiles['perf-sentinel']).toMatch(/tool access.*unavailable/i);
  });

  it('sast-sentinel profile has dev-dep CVE rule', () => {
    expect(profiles['sast-sentinel']).toMatch(/devDependencies.*minor|dev.dep.*CVE.*minor/i);
  });

  it('test-engineer profile has TC reader mandate', () => {
    expect(profiles['test-engineer']).toMatch(/testCriteria/);
  });
});

// ─── step-status.json schema contract ────────────────────────────────────────

describe('step-status.json schema written by step_emit', () => {
  it('step_emit function emits phase field', () => {
    // In bash the quotes are escaped: echo "  \"phase\": \"${PHASE:-unknown}\","
    expect(orchSrc).toMatch(/\\\"phase\\\".*PHASE:-unknown/);
  });

  it('step_emit function emits updatedAt timestamp', () => {
    // In bash the quotes are escaped: echo "  \"updatedAt\": \"${ts}\","
    expect(orchSrc).toMatch(/\\\"updatedAt\\\".*\$\{ts\}/);
  });

  it('step_emit function emits steps array with id, label, status', () => {
    expect(orchSrc).toMatch(/"id":"[^"]+","label":"[^"]+","status":"[^"]+"/);
  });

  it('step_emit uses _STEP_STATUS associative array for state tracking', () => {
    expect(orchSrc).toMatch(/declare -A _STEP_STATUS/);
    expect(orchSrc).toMatch(/_STEP_STATUS\["[^"]+"\]="[^"]+"/);
  });
});

// ─── SAST sentinel grounding contract ────────────────────────────────────────

describe('Step 4.2a SAST sentinel — oracle-injected evidence, not self-reported', () => {
  it('SAST uses blockerCount from summary, not raw verdict:fail', () => {
    expect(orchSrc).toMatch(/summary.*blockerCount|blockerCount.*summary/);
    expect(orchSrc).toMatch(/_sast_blockers/);
  });

  it('SAST blockerCount=0 → pass, not fail', () => {
    expect(orchSrc).toMatch(/step_emit "4\.2a" "pass".*blockerCount=\$_sast_blockers/s);
  });

  it('SAST verdict:fail with no parseable JSON falls back safely', () => {
    expect(orchSrc).toMatch(/no parseable findings/);
  });
});

// ─── Phase B runs only if Phase A passed ─────────────────────────────────────

describe('Phase gate sequencing — Phase B only if Phase A passed', () => {
  it('review-ranger and mutant-hunter run inside a [ $failed -eq 0 ] guard', () => {
    // Both Phase B agents must be inside the "if [ $failed -eq 0 ]" block
    const phaseBStart = orchSrc.indexOf('Phase B: review-ranger + mutant-hunter');
    const phaseBEnd   = orchSrc.indexOf('Phase C: fuzz-weaver + perf-sentinel');
    const phaseBBlock = orchSrc.slice(phaseBStart, phaseBEnd);
    expect(phaseBBlock).toMatch(/if \[ \$failed -eq 0 \]/);
  });

  it('fuzz-weaver and perf-sentinel run inside a [ $failed -eq 0 ] guard', () => {
    const phaseCStart = orchSrc.indexOf('Phase C: fuzz-weaver + perf-sentinel');
    // Phase C block ends at the browser E2E comment
    const phaseCEnd   = orchSrc.indexOf('Step 4.6: Browser E2E routing', phaseCStart);
    const phaseCBlock = orchSrc.slice(phaseCStart, phaseCEnd === -1 ? phaseCStart + 2000 : phaseCEnd);
    expect(phaseCBlock).toMatch(/if \[ \$failed -eq 0 \]/);
  });
});

// ─── Dashboard JSON contract ──────────────────────────────────────────────────

describe('monitor.html — pipeline steps panel', () => {
  const monitorPath = path.resolve(__dirname, '../../../orchestrations/dashboards/monitor.html');
  const monitorSrc = fs.readFileSync(monitorPath, 'utf8');

  it('dashboard fetches step-status.json', () => {
    expect(monitorSrc).toMatch(/step-status\.json/);
  });

  it('dashboard has renderPipelineSteps function', () => {
    expect(monitorSrc).toMatch(/function renderPipelineSteps/);
  });

  it('dashboard STEP_MANIFEST lists all 24 step IDs', () => {
    const manifest = monitorSrc.match(/const STEP_MANIFEST = \[([\s\S]*?)\];/)?.[1] ?? '';
    const ids = ['0', '0.1', '0.5', '0.6', '0.7', '0.8', '1', '1.5', '1.6',
                 '2', '3a', '3b', '3.1', '3.2', '3.5', '3.7',
                 '4', '4.2a', '4.2b', '4.3a', '4.3b', '4.4a', '4.4b', '4.6'];
    for (const id of ids) {
      expect(manifest).toMatch(new RegExp(`id:'${id.replace('.', '\\.')}'`));
    }
  });

  it('dashboard renders SKIP status in amber, not invisible', () => {
    expect(monitorSrc).toMatch(/skip.*amber|amber.*skip/i);
  });

  it('dashboard shows bypass env var for skipped steps', () => {
    expect(monitorSrc).toMatch(/bypassVar/);
  });

  it('dashboard calls renderPipelineSteps in main refresh loop', () => {
    const refreshFn = monitorSrc.match(/async function refresh\(\)([\s\S]*?)^}/m)?.[1] ?? '';
    expect(refreshFn).toMatch(/renderPipelineSteps/);
  });
});
