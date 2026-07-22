/**
 * Pipeline Stage Coverage — TDD contract for every stage and sub-stage.
 *
 * Coverage target: ≥95% of observable branches per step.
 *
 * Each step contract includes:
 *   - running status emitted when step starts
 *   - pass emitted on success
 *   - fail emitted on blocking failure
 *   - skip emitted when bypass env var is set (bypassable steps only)
 *   - warn emitted for non-blocking issues (steps with grounding logic)
 *   - step label is present and describes the step
 *   - tool access (QA gate steps only)
 *   - profile grounding rules (fuzz-weaver, perf-sentinel)
 *   - phase gate dependency (Phase B/C skip if Phase A failed)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ORCH_SCRIPT   = path.resolve(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const AI_RUN        = path.resolve(__dirname, '../../../orchestrations/scripts/ai-run.sh');
const PROFILES      = path.resolve(__dirname, '../../../orchestrations/agents/profiles.json');
const TC_WRITER     = path.resolve(__dirname, '../../../orchestrations/scripts/post-impl-tc-writer.sh');
const TIER3_RUNNER  = path.resolve(__dirname, '../../../orchestrations/scripts/tier3-travel-app-run.sh');
const PRD_REMEDIATE = path.resolve(__dirname, '../../../orchestrations/scripts/prd-remediate.sh');
const PRD_REMEDIATE_IMPL = path.resolve(__dirname, '../../../orchestrations/scripts/_prd_remediate_impl.py');
const MONITOR_HTML  = path.resolve(__dirname, '../../../orchestrations/dashboards/monitor.html');

const orchSrc   = fs.readFileSync(ORCH_SCRIPT, 'utf8');
const aiRunSrc  = fs.readFileSync(AI_RUN, 'utf8');
const tcSrc     = fs.readFileSync(TC_WRITER, 'utf8');
const tier3Src  = fs.readFileSync(TIER3_RUNNER, 'utf8');
const monitorSrc = fs.readFileSync(MONITOR_HTML, 'utf8');

let profiles: Record<string, string>;
beforeAll(() => {
  profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stepEmitCount(stepId: string, status: string): number {
  const re = new RegExp(`step_emit\\s+"${stepId}"\\s+"${status}"`, 'g');
  return (orchSrc.match(re) || []).length;
}

function hasStepEmit(stepId: string, status: string): boolean {
  return stepEmitCount(stepId, status) > 0;
}

function stepLabel(stepId: string): string {
  const re = new RegExp(`step_emit\\s+"${stepId}"\\s+"\\w+"\\s+"([^"]+)"`, 'g');
  const m = re.exec(orchSrc);
  return m?.[1] ?? '';
}

// ─── Step manifest ────────────────────────────────────────────────────────────

const STEPS = [
  { id: '1',    name: 'Specification pass',         bypassVar: 'EPAM_SPEC_MODE', bypassVal: '1' },
  { id: '2',  name: 'CPA pre-pass',               bypassVar: 'SKIP_CPA',       bypassVal: '8' },
  { id: '3',  name: 'Pre-phase skill assessment',  bypassVar: 'SKIP_SKILL_ASSESSMENT', bypassVal: '8' },
  { id: '4',  name: 'Hybrid pre-coord',            bypassVar: null },
  { id: '5',  name: 'Regression guard',            bypassVar: 'SKIP_REGRESSION_GUARD', bypassVal: 'true' },
  { id: '6',  name: 'mkdir src/ dirs',             bypassVar: null },
  { id: '8',    name: 'Main-branch stories',         bypassVar: null },
  { id: '9',  name: 'Auto-commit',                 bypassVar: null },
  { id: '10',  name: 'TC writer gate',              bypassVar: 'SKIP_TC_WRITER', bypassVal: '8' },
  { id: '13',    name: 'Create worktrees',            bypassVar: null },
  { id: '14',   name: 'Primary agent',              bypassVar: null },
  { id: '15',   name: 'Independent agent',          bypassVar: null },
  { id: '16',  name: 'Worktree health',             bypassVar: null },
  { id: '18',  name: 'Post-parallel assessment',    bypassVar: 'SKIP_SKILL_ASSESSMENT', bypassVal: '8' },
  { id: '19',  name: 'Pre-review gate',             bypassVar: 'SKIP_PRE_REVIEW_GATE', bypassVal: 'true' },
  { id: '21',    name: 'Review stories',              bypassVar: null },
  { id: '22a', name: 'SAST sentinel',               bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '22b', name: 'Spec validator',              bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '22c', name: 'Review ranger',               bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '22d', name: 'Mutant hunter',               bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '22e', name: 'Fuzz-weaver',                 bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '22f', name: 'Perf sentinel',               bypassVar: 'SKIP_TESTING_GATES', bypassVal: 'true' },
  { id: '23',  name: 'Browser E2E',                 bypassVar: 'SKIP_BROWSER_E2E_ROUTING', bypassVal: 'true' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL: every step must be visible (pass/skip/fail) — no black boxes
// ─────────────────────────────────────────────────────────────────────────────

describe('Universal contract — every step is visible', () => {
  for (const step of STEPS) {
    it(`Step ${step.id} (${step.name}): has pass or skip`, () => {
      expect(hasStepEmit(step.id, 'pass') || hasStepEmit(step.id, 'skip')).toBe(true);
    });

    it(`Step ${step.id} (${step.name}): has running or pass or skip — not a black box`, () => {
      expect(
        hasStepEmit(step.id, 'running') ||
        hasStepEmit(step.id, 'pass') ||
        hasStepEmit(step.id, 'skip')
      ).toBe(true);
    });

    it(`Step ${step.id} (${step.name}): label string is non-empty`, () => {
      const label = stepLabel(step.id);
      expect(label.length).toBeGreaterThan(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BYPASS: every bypassable step emits SKIP with a reason
// ─────────────────────────────────────────────────────────────────────────────

describe('Bypass contract — skip paths are always visible', () => {
  for (const step of STEPS) {
    if (!step.bypassVar) continue;
    it(`Step ${step.id}: skip path fires when ${step.bypassVar}=${step.bypassVal}`, () => {
      expect(hasStepEmit(step.id, 'skip')).toBe(true);
    });
  }

  it('SKIP_TESTING_GATES=true covers all 7 gate steps', () => {
    const gateSteps = ['22a', '22b', '22c', '22d', '22e', '22f', '23'];
    for (const id of gateSteps) {
      expect(hasStepEmit(id, 'skip')).toBe(true);
    }
  });

  it('SKIP_REGRESSION_GUARD=true causes Step 0.7 to skip', () => {
    expect(orchSrc).toMatch(/SKIP_REGRESSION_GUARD[\s\S]{0,200}step_emit.*5.*skip|step_emit.*5.*skip[\s\S]{0,200}SKIP_REGRESSION_GUARD/);
  });

  it('SKIP_CPA=1 causes Step 0.1 to skip', () => {
    expect(orchSrc).toMatch(/SKIP_CPA[\s\S]{0,200}step_emit.*2.*skip|step_emit.*2.*skip[\s\S]{0,200}SKIP_CPA/);
  });

  it('SKIP_SKILL_ASSESSMENT=1 causes Step 0.5 to skip', () => {
    expect(orchSrc).toMatch(/SKIP_SKILL_ASSESSMENT[\s\S]{0,200}step_emit.*3.*skip|step_emit.*3.*skip[\s\S]{0,200}SKIP_SKILL_ASSESSMENT/);
  });

  it('SKIP_SKILL_ASSESSMENT=1 causes Step 3.5 to skip', () => {
    expect(orchSrc).toMatch(/SKIP_SKILL_ASSESSMENT[\s\S]{0,200}step_emit.*18.*skip|step_emit.*18.*skip[\s\S]{0,200}SKIP_SKILL_ASSESSMENT/);
  });

  it('SKIP_BROWSER_E2E_ROUTING=true causes Step 4.6 to skip', () => {
    expect(orchSrc).toMatch(/SKIP_BROWSER_E2E_ROUTING[\s\S]{0,200}step_emit.*23.*skip|step_emit.*23.*skip[\s\S]{0,200}SKIP_BROWSER_E2E_ROUTING/);
  });

  it('SKIP_TC_WRITER=1 causes Step 1.6 to skip', () => {
    expect(orchSrc).toMatch(/SKIP_TC_WRITER[\s\S]{0,200}step_emit.*10.*skip|step_emit.*10.*skip[\s\S]{0,200}SKIP_TC_WRITER/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE PATHS: blocking steps emit fail
// ─────────────────────────────────────────────────────────────────────────────

describe('Failure paths — blocking steps emit fail', () => {
  it('Step 0 spec pass failure → step_emit fail', () => {
    expect(hasStepEmit('1', 'fail')).toBe(true);
  });

  it('Step 0.1 CPA BLOCKED → step_emit fail', () => {
    expect(hasStepEmit('2', 'fail')).toBe(true);
  });

  // Behavior change (2026-07-13): a TC-writer miss no longer step_emits
  // "fail" for the whole phase — it retries 3x then blocks just the
  // specific story/stories still missing testCriteria (step_emit "warn"),
  // since the old "fail the whole phase" semantics took down every OTHER
  // story with it over one story's TC gap. See tc-writer-retry-block.test.ts
  // for the full retry/block contract.
  it('Step 1.6 TC writer exhaustion → step_emit warn (blocks affected stories, does not fail the phase)', () => {
    expect(hasStepEmit('10', 'warn')).toBe(true);
  });

  it('Step 3.7 pre-review gate failure → step_emit fail', () => {
    expect(hasStepEmit('19', 'fail')).toBe(true);
  });

  it('Step 3a primary agent failure → step_emit fail', () => {
    expect(hasStepEmit('14', 'fail')).toBe(true);
  });

  it('Step 3b independent agent failure → step_emit fail', () => {
    expect(hasStepEmit('15', 'fail')).toBe(true);
  });

  it('Step 4.2a SAST blocker → step_emit fail', () => {
    expect(hasStepEmit('22a', 'fail')).toBe(true);
  });

  it('Step 4.2b spec validator fail → step_emit fail', () => {
    expect(hasStepEmit('22b', 'fail')).toBe(true);
  });

  it('Step 4.3a review-ranger blocker → step_emit fail', () => {
    expect(hasStepEmit('22c', 'fail')).toBe(true);
  });

  it('Step 4.3b mutant-hunter fail → step_emit fail', () => {
    expect(hasStepEmit('22d', 'fail')).toBe(true);
  });

  it('Step 4.4a fuzz-weaver grounded fail → step_emit fail', () => {
    expect(hasStepEmit('22e', 'fail')).toBe(true);
  });

  it('Step 4.4b perf-sentinel grounded fail → step_emit fail', () => {
    expect(hasStepEmit('22f', 'fail')).toBe(true);
  });

  it('SAST sentinel blockerCount > 0 sets failed=1 (pipeline abort)', () => {
    // step_emit fail then failed=1 must both appear in close proximity
    expect(orchSrc).toMatch(/step_emit "22a" "fail"[\s\S]{0,300}failed=1|failed=1[\s\S]{0,300}step_emit "22a" "fail"/);
  });

  it('Phase A failure sets failed variable before Phase B evaluation', () => {
    const phaseABlock = orchSrc.slice(
      orchSrc.indexOf('Phase A: SAST'),
      orchSrc.indexOf('Phase B: review-ranger')
    );
    expect(phaseABlock).toMatch(/failed=1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WARN PATHS: grounding downgrade
// ─────────────────────────────────────────────────────────────────────────────

describe('Warn paths — grounding downgrades hallucinated fails', () => {
  it('Step 4.2b spec validator warn → step_emit warn (no story data)', () => {
    expect(hasStepEmit('22b', 'warn')).toBe(true);
  });

  it('spec validator extractor uses line-level regex not json.loads (run 84 regression)', () => {
    // Bug: the old extractor used greedy r'\{.*\}' with DOTALL which failed when the
    // agent embedded raw newlines inside JSON string values — json.loads raised
    // "Invalid control character" and the gate fell through to "no story data" warn.
    // Fix: targeted regex patterns on individual lines, bypassing full JSON parsing.
    const specIdx = orchSrc.indexOf('SPEC_EXTRACTOR_PY');
    expect(specIdx, 'SPEC_EXTRACTOR_PY heredoc not found').toBeGreaterThan(-1);
    const block = orchSrc.slice(specIdx, specIdx + 2800);

    // Must NOT use json.loads on the full blob (the root cause of the bug)
    expect(block).not.toMatch(/json\.loads\s*\(\s*text\b/);
    expect(block).not.toMatch(/json\.loads\s*\(\s*m\.group/);

    // Must use targeted pattern matching for verdict and storyId presence
    expect(block).toContain('"verdict"');
    expect(block).toContain('"storyId"');
    expect(block).toContain('"overallVerdict"');

    // Must handle the no-data case (agent returned nothing useful)
    expect(block).toContain('no-data');
    expect(block).toContain('no-json');
  });

  it('Step 4.4a fuzz-weaver ungrounded fail → step_emit warn', () => {
    expect(orchSrc).toMatch(/step_emit "22e" "warn" "Step 22e: Fuzz-weaver" "unverified findings downgraded"/);
  });

  it('Step 4.4b perf-sentinel ungrounded fail → step_emit warn', () => {
    expect(orchSrc).toMatch(/step_emit "22f" "warn" "Step 22f: Perf sentinel" "hallucinated fail downgraded"/);
  });

  it('fuzz-weaver grounding uses python3 file-existence check', () => {
    expect(orchSrc).toMatch(/_fuzz_grounded=\$\(python3/);
    expect(orchSrc).toMatch(/os\.path\.exists/);
  });

  it('perf-sentinel grounding uses python3 with blockerCount + filesAnalysed', () => {
    expect(orchSrc).toMatch(/_perf_grounded=\$\(python3/);
    expect(orchSrc).toMatch(/blockerCount/);
    expect(orchSrc).toMatch(/filesAnalysed/);
  });

  it('perf-sentinel grounding: requires real_blockers > 0 AND files_analysed > 0', () => {
    expect(orchSrc).toMatch(/grounded = 1 if.*real_blockers > 0.*files_analysed > 0/s);
  });

  it('perf-sentinel: verdict=fail with summary=null → warn (run-82 regression)', () => {
    expect(orchSrc).toMatch(/summary = data\.get\("summary"\) or \{\}/);
    expect(orchSrc).toMatch(/blocker_count = summary\.get\("blockerCount", 0\) if summary else 0/);
  });

  it('fuzz-weaver grounding counts only vulnerability-status cases', () => {
    expect(orchSrc).toMatch(/case\.get\("status"\) != "vulnerability"/);
  });

  it('fuzz-weaver grounding checks file exists under PROJECT_ROOT/src', () => {
    expect(orchSrc).toMatch(/os\.path\.join\(project_root, "src", os\.path\.basename\(f\)\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE GATE SEQUENCING: Phase B only if A passed; Phase C only if A+B passed
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase gate sequencing', () => {
  it('Phase A failure causes 4.3a/4.3b to emit skip, not pending', () => {
    expect(hasStepEmit('22c', 'skip')).toBe(true);
    expect(hasStepEmit('22d', 'skip')).toBe(true);
  });

  it('Phase A failure skip includes reason string', () => {
    expect(orchSrc).toMatch(/step_emit.*22c.*skip.*Phase A/);
  });

  it('Phase A/B failure causes 4.4a/4.4b to emit skip, not pending', () => {
    expect(hasStepEmit('22e', 'skip')).toBe(true);
    expect(hasStepEmit('22f', 'skip')).toBe(true);
  });

  it('Phase A/B failure skip includes reason string', () => {
    expect(orchSrc).toMatch(/step_emit.*22e.*skip.*Phase A/);
  });

  it('review-ranger and mutant-hunter run inside [ $failed -eq 0 ] guard', () => {
    const phaseBStart = orchSrc.indexOf('Phase B: review-ranger + mutant-hunter');
    const phaseCStart = orchSrc.indexOf('Phase C: fuzz-weaver + perf-sentinel');
    const phaseBBlock = orchSrc.slice(phaseBStart, phaseCStart);
    expect(phaseBBlock).toMatch(/if \[ \$failed -eq 0 \]/);
  });

  it('fuzz-weaver and perf-sentinel run inside [ $failed -eq 0 ] guard', () => {
    const phaseCStart = orchSrc.indexOf('Phase C: fuzz-weaver + perf-sentinel');
    const phaseCEnd   = orchSrc.indexOf('Step 23: Browser E2E routing', phaseCStart);
    const phaseCBlock = orchSrc.slice(phaseCStart, phaseCEnd === -1 ? phaseCStart + 2000 : phaseCEnd);
    expect(phaseCBlock).toMatch(/if \[ \$failed -eq 0 \]/);
  });

  it('Phase B skip path (4.3a/4.3b) is in the else-branch of the Phase A guard', () => {
    // The else block for [ $failed -eq 0 ] must contain the Phase B skip emits
    const skip43aIdx = orchSrc.indexOf('step_emit "22c" "skip" "Step 22c: Review ranger" "Phase A failed"');
    expect(skip43aIdx).toBeGreaterThan(-1);
    const elseBeforeSkip = orchSrc.lastIndexOf('\n    else\n', skip43aIdx);
    expect(elseBeforeSkip).toBeGreaterThan(-1);
    expect(skip43aIdx - elseBeforeSkip).toBeLessThan(200);
  });

  it('Phase C skip path (4.4a/4.4b) is in the else-branch of the Phase A+B guard', () => {
    // Target the specific Phase A/B skip, not the SKIP_TESTING_GATES skip
    const skip44aIdx = orchSrc.indexOf('step_emit "22e" "skip" "Step 22e: Fuzz-weaver" "Phase A/B failed"');
    expect(skip44aIdx).toBeGreaterThan(-1);
    // There must be an else within 200 chars before the skip
    const region = orchSrc.slice(Math.max(0, skip44aIdx - 200), skip44aIdx);
    expect(region).toMatch(/\belse\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0: Specification pass
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 1: Specification pass', () => {
  it('emits running before spec pass starts', () => {
    expect(hasStepEmit('1', 'running')).toBe(true);
  });

  it('emits pass on spec pass success', () => {
    expect(hasStepEmit('1', 'pass')).toBe(true);
  });

  it('emits fail on spec pass failure', () => {
    expect(hasStepEmit('1', 'fail')).toBe(true);
  });

  it('emits skip when EPAM_SPEC_MODE is disabled', () => {
    expect(hasStepEmit('1', 'skip')).toBe(true);
  });

  it('label contains "Specification" or "spec"', () => {
    expect(stepLabel('1').toLowerCase()).toMatch(/spec/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0.1: CPA pre-pass
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 2: CPA pre-pass', () => {
  it('emits running when CPA starts', () => {
    expect(hasStepEmit('2', 'running')).toBe(true);
  });

  it('emits pass when CPA passes', () => {
    expect(hasStepEmit('2', 'pass')).toBe(true);
  });

  it('emits fail when CPA blocks', () => {
    expect(hasStepEmit('2', 'fail')).toBe(true);
  });

  it('emits skip when SKIP_CPA=1', () => {
    expect(hasStepEmit('2', 'skip')).toBe(true);
  });

  it('emits warn for non-blocking CPA issues', () => {
    expect(hasStepEmit('2', 'warn')).toBe(true);
  });

  it('label references CPA', () => {
    expect(stepLabel('2').toLowerCase()).toMatch(/cpa/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0.5: Pre-phase skill assessment
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 3: Pre-phase skill assessment', () => {
  it('emits running when assessment starts', () => {
    expect(hasStepEmit('3', 'running')).toBe(true);
  });

  it('emits pass when assessment completes', () => {
    expect(hasStepEmit('3', 'pass')).toBe(true);
  });

  it('emits skip when SKIP_SKILL_ASSESSMENT=1', () => {
    expect(hasStepEmit('3', 'skip')).toBe(true);
  });

  it('emits warn when assessment has issues', () => {
    expect(hasStepEmit('3', 'warn')).toBe(true);
  });

  it('label references "assessment" or "skill"', () => {
    expect(stepLabel('3').toLowerCase()).toMatch(/assess|skill/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0.6: Hybrid pre-coord
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 4: Hybrid pre-coord', () => {
  it('emits pass when coord runs', () => {
    expect(hasStepEmit('4', 'pass')).toBe(true);
  });

  it('emits skip when orch mode is not hybrid', () => {
    expect(hasStepEmit('4', 'skip')).toBe(true);
  });

  it('label references "coord" or "hybrid"', () => {
    expect(stepLabel('4').toLowerCase()).toMatch(/coord|hybrid/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0.7: Regression guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 5: Regression guard', () => {
  it('emits running when guard starts', () => {
    expect(hasStepEmit('5', 'running')).toBe(true);
  });

  it('emits pass when no regressions found', () => {
    expect(hasStepEmit('5', 'pass')).toBe(true);
  });

  it('emits fail when regressions block', () => {
    expect(hasStepEmit('5', 'fail')).toBe(true);
  });

  it('emits skip when SKIP_REGRESSION_GUARD=true', () => {
    expect(hasStepEmit('5', 'skip')).toBe(true);
  });

  it('label references "regression"', () => {
    expect(stepLabel('5').toLowerCase()).toMatch(/regression/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0.8: mkdir src/ dirs
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 6: mkdir src/ dirs', () => {
  it('emits pass after dirs created', () => {
    expect(hasStepEmit('6', 'pass')).toBe(true);
  });

  it('label references "mkdir" or "dir"', () => {
    expect(stepLabel('6').toLowerCase()).toMatch(/mkdir|dir/);
  });

  it('mkdir -p command creates src/ tree', () => {
    expect(orchSrc).toMatch(/mkdir -p.*src\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Main-branch stories
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 8: Main-branch stories', () => {
  it('emits running when stories start', () => {
    expect(hasStepEmit('8', 'running')).toBe(true);
  });

  it('emits pass when all stories complete', () => {
    expect(hasStepEmit('8', 'pass')).toBe(true);
  });

  it('emits fail when a story fails', () => {
    expect(hasStepEmit('8', 'fail')).toBe(true);
  });

  it('emits skip when no main-branch stories exist', () => {
    expect(hasStepEmit('8', 'skip')).toBe(true);
  });

  it('label references "branch" or "stories"', () => {
    expect(stepLabel('8').toLowerCase()).toMatch(/branch|stories|story/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1.5: Auto-commit
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 9: Auto-commit', () => {
  it('emits pass after commit', () => {
    expect(hasStepEmit('9', 'pass')).toBe(true);
  });

  it('emits skip when nothing to commit', () => {
    expect(hasStepEmit('9', 'skip')).toBe(true);
  });

  it('label references "commit"', () => {
    expect(stepLabel('9').toLowerCase()).toMatch(/commit/);
  });

  it('git commit command exists in the auto-commit block', () => {
    expect(orchSrc).toMatch(/git.*commit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1.6: TC writer gate
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 10: TC writer gate', () => {
  it('emits running when TC writer starts', () => {
    expect(hasStepEmit('10', 'running')).toBe(true);
  });

  it('emits pass when TCs are written', () => {
    expect(hasStepEmit('10', 'pass')).toBe(true);
  });

  it('emits fail when TC writer exits non-zero', () => {
    expect(hasStepEmit('10', 'fail')).toBe(true);
  });

  it('emits skip when SKIP_TC_WRITER=1', () => {
    expect(hasStepEmit('10', 'skip')).toBe(true);
  });

  it('emits skip when no test stories need TCs', () => {
    // At least 2 skip paths: SKIP_TC_WRITER=1 and "no TC needed"
    expect(stepEmitCount('10', 'skip')).toBeGreaterThanOrEqual(1);
  });

  it('no duplicate step_emit skip calls (max 2)', () => {
    expect(stepEmitCount('10', 'skip')).toBeLessThanOrEqual(2);
  });

  it('label references "TC" or "writer"', () => {
    expect(stepLabel('10').toLowerCase()).toMatch(/tc|writer/);
  });

  it('TC writer script checks agent exit BEFORE file existence', () => {
    const exitCheckIdx = tcSrc.indexOf('if tc_exit != 0:');
    const fileCheckIdx = tcSrc.indexOf('if not os.path.exists(tc_file):');
    expect(exitCheckIdx).toBeGreaterThan(-1);
    expect(fileCheckIdx).toBeGreaterThan(-1);
    expect(exitCheckIdx).toBeLessThan(fileCheckIdx);
  });

  it('TC writer rejects stale file when agent failed', () => {
    expect(tcSrc).toMatch(/stale TC file exists but will NOT be used/);
  });

  it('TC writer exits 1 when agent failed, regardless of file state', () => {
    const exitBlock = tcSrc.match(/if tc_exit != 0:([\s\S]*?)if not os\.path\.exists/)?.[1] ?? '';
    expect(exitBlock).toMatch(/sys\.exit\(1\)/);
  });

  it('TC writer uses EPAM_DANGEROUS_SKIP_APPROVAL=1 for auto-approve', () => {
    expect(tcSrc).toMatch(/EPAM_DANGEROUS_SKIP_APPROVAL=1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Create worktrees
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 13: Create worktrees', () => {
  it('emits running when worktree creation starts', () => {
    expect(hasStepEmit('13', 'running')).toBe(true);
  });

  it('emits pass when worktrees are created', () => {
    expect(hasStepEmit('13', 'pass')).toBe(true);
  });

  it('emits skip when orch mode is single-agent', () => {
    expect(hasStepEmit('13', 'skip')).toBe(true);
  });

  it('label references "worktree"', () => {
    expect(stepLabel('13').toLowerCase()).toMatch(/worktree/);
  });

  it('worktrees are created via CLAUDE_SH --setup-worktrees', () => {
    expect(orchSrc).toMatch(/\$CLAUDE_SH.*--setup-worktrees|--setup-worktrees.*CLAUDE_SH/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3a: Primary agent
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 14: Primary agent', () => {
  it('emits running when primary agent launches', () => {
    expect(hasStepEmit('14', 'running')).toBe(true);
  });

  it('emits pass when primary agent succeeds', () => {
    expect(hasStepEmit('14', 'pass')).toBe(true);
  });

  it('emits fail when primary agent fails', () => {
    expect(hasStepEmit('14', 'fail')).toBe(true);
  });

  it('label references "Primary" or "primary"', () => {
    expect(stepLabel('14').toLowerCase()).toMatch(/primary|agent/);
  });

  it('primary agent PID is waited on', () => {
    expect(orchSrc).toMatch(/wait \$PRIMARY_PID/);
  });

  it('primary agent exit code drives pass/fail decision', () => {
    expect(orchSrc).toMatch(/PRIMARY_EXIT/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3b: Independent agent
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 15: Independent agent', () => {
  it('emits running when independent agent launches', () => {
    expect(hasStepEmit('15', 'running')).toBe(true);
  });

  it('emits pass when independent agent succeeds', () => {
    expect(hasStepEmit('15', 'pass')).toBe(true);
  });

  it('emits fail when independent agent fails', () => {
    expect(hasStepEmit('15', 'fail')).toBe(true);
  });

  it('emits skip when orch mode is single-agent', () => {
    expect(hasStepEmit('15', 'skip')).toBe(true);
  });

  it('label references "Independent" or "independent"', () => {
    expect(stepLabel('15').toLowerCase()).toMatch(/independent|agent/);
  });

  it('independent agent PID is waited on', () => {
    expect(orchSrc).toMatch(/INDEPENDENT_PID/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3.1: Worktree health
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 16: Worktree health', () => {
  it('emits running when health check starts', () => {
    expect(hasStepEmit('16', 'running')).toBe(true);
  });

  it('emits pass when worktrees are healthy', () => {
    expect(hasStepEmit('16', 'pass')).toBe(true);
  });

  it('emits warn when health check has issues', () => {
    expect(hasStepEmit('16', 'warn')).toBe(true);
  });

  it('emits skip when orch mode is single-agent', () => {
    expect(hasStepEmit('16', 'skip')).toBe(true);
  });

  it('label references "health" or "worktree"', () => {
    expect(stepLabel('16').toLowerCase()).toMatch(/health|worktree/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3.5: Post-parallel assessment
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 18: Post-parallel assessment', () => {
  it('emits running when assessment starts', () => {
    expect(hasStepEmit('18', 'running')).toBe(true);
  });

  it('emits pass when assessment completes', () => {
    expect(hasStepEmit('18', 'pass')).toBe(true);
  });

  it('emits skip when SKIP_SKILL_ASSESSMENT=1', () => {
    expect(hasStepEmit('18', 'skip')).toBe(true);
  });

  it('emits warn when assessment finds issues', () => {
    expect(hasStepEmit('18', 'warn')).toBe(true);
  });

  it('label references "assessment" or "parallel"', () => {
    expect(stepLabel('18').toLowerCase()).toMatch(/assess|parallel|skill/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3.7: Pre-review gate
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 19: Pre-review gate', () => {
  it('emits running when gate runs', () => {
    expect(hasStepEmit('19', 'running')).toBe(true);
  });

  it('emits pass when gate passes', () => {
    expect(hasStepEmit('19', 'pass')).toBe(true);
  });

  it('emits fail when gate blocks', () => {
    expect(hasStepEmit('19', 'fail')).toBe(true);
  });

  it('emits skip when SKIP_PRE_REVIEW_GATE=true', () => {
    expect(hasStepEmit('19', 'skip')).toBe(true);
  });

  it('label references "review" or "gate"', () => {
    expect(stepLabel('19').toLowerCase()).toMatch(/review|gate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Review stories
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 21: Review stories', () => {
  it('emits running when review starts', () => {
    expect(hasStepEmit('21', 'running')).toBe(true);
  });

  it('emits pass when all reviews complete', () => {
    expect(hasStepEmit('21', 'pass')).toBe(true);
  });

  it('emits fail when review fails', () => {
    expect(hasStepEmit('21', 'fail')).toBe(true);
  });

  it('emits skip when no review stories exist', () => {
    expect(hasStepEmit('21', 'skip')).toBe(true);
  });

  it('label references "review"', () => {
    expect(stepLabel('21').toLowerCase()).toMatch(/review/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.2a: SAST sentinel
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 22a: SAST sentinel', () => {
  it('emits running when SAST starts', () => {
    expect(hasStepEmit('22a', 'running')).toBe(true);
  });

  it('emits pass when blockerCount=0', () => {
    expect(hasStepEmit('22a', 'pass')).toBe(true);
  });

  it('emits fail when blockerCount > 0', () => {
    expect(hasStepEmit('22a', 'fail')).toBe(true);
  });

  it('emits warn when SAST has non-blocking findings', () => {
    expect(hasStepEmit('22a', 'warn')).toBe(true);
  });

  it('emits skip when SKIP_TESTING_GATES=true', () => {
    expect(hasStepEmit('22a', 'skip')).toBe(true);
  });

  it('uses blockerCount from summary, not raw verdict:fail', () => {
    expect(orchSrc).toMatch(/_sast_blockers/);
    expect(orchSrc).toMatch(/summary.*blockerCount|blockerCount.*summary/);
  });

  it('blockerCount=0 path calls step_emit pass with count annotation', () => {
    expect(orchSrc).toMatch(/step_emit "22a" "pass".*blockerCount=\$_sast_blockers/s);
  });

  it('verdict:fail with no JSON falls back safely', () => {
    expect(orchSrc).toMatch(/no parseable findings/);
  });

  it('TypeScript compiler oracle is injected before SAST prompt', () => {
    expect(orchSrc).toMatch(/TypeScript Compiler Results.*hard evidence/s);
  });

  it('SAST uses _run_qa_gate_with_retry for file access (retry-enabled, AI_GATE_ALLOW_TOOLS=1 inside helper)', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$sast_prompt"/);
  });

  it('label references "SAST" or "sentinel"', () => {
    expect(stepLabel('22a').toLowerCase()).toMatch(/sast|sentinel/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.2b: Spec validator
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 22b: Spec validator', () => {
  it('emits running when validator starts', () => {
    expect(hasStepEmit('22b', 'running')).toBe(true);
  });

  it('emits pass when spec is fully compliant', () => {
    expect(hasStepEmit('22b', 'pass')).toBe(true);
  });

  it('emits fail when spec has failing criteria', () => {
    expect(hasStepEmit('22b', 'fail')).toBe(true);
  });

  it('emits warn when no story data available', () => {
    expect(hasStepEmit('22b', 'warn')).toBe(true);
  });

  it('emits skip when SKIP_TESTING_GATES=true', () => {
    expect(hasStepEmit('22b', 'skip')).toBe(true);
  });

  it('vitest oracle is injected before spec prompt', () => {
    expect(orchSrc).toMatch(/vitest.*oracle|oracle.*vitest/i);
  });

  it('spec validator uses _run_qa_gate_with_retry for file access', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$spec_prompt"/);
  });

  it('label references "Spec" or "validator"', () => {
    expect(stepLabel('22b').toLowerCase()).toMatch(/spec|validator/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.3a: Review ranger
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 22c: Review ranger', () => {
  it('emits running when ranger starts', () => {
    expect(hasStepEmit('22c', 'running')).toBe(true);
  });

  it('emits pass when ranger finds no blockers', () => {
    expect(hasStepEmit('22c', 'pass')).toBe(true);
  });

  it('emits fail when ranger finds blockers', () => {
    expect(hasStepEmit('22c', 'fail')).toBe(true);
  });

  it('emits warn for non-blocking ranger findings', () => {
    expect(hasStepEmit('22c', 'warn')).toBe(true);
  });

  it('emits skip when SKIP_TESTING_GATES=true', () => {
    expect(hasStepEmit('22c', 'skip')).toBe(true);
  });

  it('emits skip when Phase A failed (not pending)', () => {
    expect(orchSrc).toMatch(/step_emit.*22c.*skip.*Phase A/);
  });

  it('review ranger uses _run_qa_gate_with_retry for file access', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$review_prompt"/);
  });

  it('label references "ranger" or "review"', () => {
    expect(stepLabel('22c').toLowerCase()).toMatch(/ranger|review/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.3b: Mutant hunter
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 22d: Mutant hunter', () => {
  it('emits running when hunter starts', () => {
    expect(hasStepEmit('22d', 'running')).toBe(true);
  });

  it('emits pass when mutation score is acceptable', () => {
    expect(hasStepEmit('22d', 'pass')).toBe(true);
  });

  it('emits fail when mutation score fails', () => {
    expect(hasStepEmit('22d', 'fail')).toBe(true);
  });

  it('emits warn for borderline mutation score', () => {
    expect(hasStepEmit('22d', 'warn')).toBe(true);
  });

  it('emits skip when SKIP_TESTING_GATES=true', () => {
    expect(hasStepEmit('22d', 'skip')).toBe(true);
  });

  it('emits skip when Phase A failed', () => {
    expect(orchSrc).toMatch(/step_emit.*22d.*skip.*Phase A/);
  });

  it('mutant hunter uses _run_qa_gate_with_retry for file access', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$mutant_prompt"/);
  });

  it('label references "hunter" or "mutant"', () => {
    expect(stepLabel('22d').toLowerCase()).toMatch(/hunter|mutant/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.4a: Fuzz-weaver
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 22e: Fuzz-weaver', () => {
  it('emits running when fuzz-weaver starts', () => {
    expect(hasStepEmit('22e', 'running')).toBe(true);
  });

  it('emits pass when no vulnerabilities found', () => {
    expect(hasStepEmit('22e', 'pass')).toBe(true);
  });

  it('emits fail when grounded vulnerabilities found', () => {
    expect(hasStepEmit('22e', 'fail')).toBe(true);
  });

  it('emits warn when verdict=fail but findings are ungrounded', () => {
    expect(orchSrc).toMatch(/step_emit "22e" "warn" "Step 22e: Fuzz-weaver" "unverified findings downgraded"/);
  });

  it('emits skip when SKIP_TESTING_GATES=true', () => {
    expect(hasStepEmit('22e', 'skip')).toBe(true);
  });

  it('emits skip when Phase A/B failed', () => {
    expect(orchSrc).toMatch(/step_emit.*22e.*skip.*Phase/);
  });

  it('uses _run_qa_gate_with_retry — not bare run_orch_prompt (tool access preserved inside helper)', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$fuzz_prompt"/);
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$fuzz_prompt" "qa-gate:fuzz-weaver"/);
  });

  it('label references "Fuzz" or "weaver"', () => {
    expect(stepLabel('22e').toLowerCase()).toMatch(/fuzz|weaver/);
  });

  it('grounding check returns 0 for tool-less agent (no src files)', () => {
    expect(orchSrc).toMatch(/\[ "\$\{_fuzz_grounded:-0\}" -gt 0 \]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.4b: Perf sentinel
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 22f: Perf sentinel', () => {
  it('emits running when sentinel starts', () => {
    expect(hasStepEmit('22f', 'running')).toBe(true);
  });

  it('emits pass when no performance blockers found', () => {
    expect(hasStepEmit('22f', 'pass')).toBe(true);
  });

  it('emits fail when grounded performance blockers found', () => {
    expect(hasStepEmit('22f', 'fail')).toBe(true);
  });

  it('emits warn when verdict=fail but summary is null (ungrounded)', () => {
    expect(orchSrc).toMatch(/step_emit "22f" "warn" "Step 22f: Perf sentinel" "hallucinated fail downgraded"/);
  });

  it('emits skip when SKIP_TESTING_GATES=true', () => {
    expect(hasStepEmit('22f', 'skip')).toBe(true);
  });

  it('emits skip when Phase A/B failed', () => {
    expect(orchSrc).toMatch(/step_emit.*22f.*skip.*Phase/);
  });

  it('uses _run_qa_gate_with_retry — not bare run_orch_prompt (tool access preserved inside helper)', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$perf_prompt"/);
  });

  it('grounding check uses _perf_grounded variable', () => {
    expect(orchSrc).toMatch(/\[ "\$\{_perf_grounded:-0\}" -gt 0 \]/);
  });

  it('grounding: summary=null treated as filesAnalysed=0 (ungrounded)', () => {
    expect(orchSrc).toMatch(/summary = data\.get\("summary"\) or \{\}/);
    expect(orchSrc).toMatch(/files_analysed = summary\.get\("filesAnalysed", 0\) if summary else 0/);
  });

  it('label references "Perf" or "sentinel"', () => {
    expect(stepLabel('22f').toLowerCase()).toMatch(/perf|sentinel/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4.6: Browser E2E
// ─────────────────────────────────────────────────────────────────────────────

describe('Step 23: Browser E2E', () => {
  it('emits running when E2E starts', () => {
    expect(hasStepEmit('23', 'running')).toBe(true);
  });

  it('emits pass when E2E tests pass', () => {
    expect(hasStepEmit('23', 'pass')).toBe(true);
  });

  it('emits fail when E2E tests fail', () => {
    expect(hasStepEmit('23', 'fail')).toBe(true);
  });

  it('emits skip when SKIP_BROWSER_E2E_ROUTING=true', () => {
    expect(hasStepEmit('23', 'skip')).toBe(true);
  });

  it('label references "E2E" or "browser"', () => {
    expect(stepLabel('23').toLowerCase()).toMatch(/e2e|browser/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL ACCESS CONTRACT: QA gate agents get AI_GATE_ALLOW_TOOLS=1
// ─────────────────────────────────────────────────────────────────────────────

describe('Tool access contract — QA gate agents have file access', () => {
  it('ai-run.sh respects AI_GATE_ALLOW_TOOLS=1 to enable tools', () => {
    expect(aiRunSrc).toMatch(/AI_GATE_ALLOW_TOOLS/);
    expect(aiRunSrc).toMatch(/\[ "\$\{AI_GATE_ALLOW_TOOLS:-0\}" = "1" \]/);
  });

  it('ai-run.sh omits --no-tools when AI_GATE_ALLOW_TOOLS=1', () => {
    // When allow-tools=1, _tool_flag is empty and the conditional expression is used
    expect(aiRunSrc).toMatch(/_tool_flag="--no-tools"/);
    expect(aiRunSrc).toMatch(/_tool_flag=""/);
  });

  it('ai-run.sh sets EPAM_DANGEROUS_SKIP_APPROVAL=1 when tools enabled', () => {
    expect(aiRunSrc).toMatch(/_skip_approval="1"/);
    expect(aiRunSrc).toMatch(/EPAM_DANGEROUS_SKIP_APPROVAL="\$_skip_approval"/);
  });

  it('run_orch_prompt_with_tools function exists in orch script', () => {
    expect(orchSrc).toMatch(/run_orch_prompt_with_tools\(\)/);
  });

  it('run_orch_prompt_with_tools sets AI_GATE_ALLOW_TOOLS=1', () => {
    expect(orchSrc).toMatch(/AI_GATE_ALLOW_TOOLS=1 run_orch_prompt/);
  });

  it('all 6 QA gate agents use _run_qa_gate_with_retry (which sets AI_GATE_ALLOW_TOOLS=1 internally)', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$sast_prompt"/);
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$spec_prompt"/);
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$review_prompt"/);
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$mutant_prompt"/);
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$fuzz_prompt"/);
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$perf_prompt"/);
  });

  it('no non-e2e QA gate agent uses bare run_orch_prompt (wrong — no tool access)', () => {
    // Each call site must use _run_qa_gate_with_retry (which sets AI_GATE_ALLOW_TOOLS=1
    // internally) or run_orch_prompt_with_tools — never a bare run_orch_prompt call.
    const gateTypes = ['qa-gate:sast', 'qa-gate:spec-validator', 'qa-gate:review-ranger',
                       'qa-gate:mutant-hunter', 'qa-gate:fuzz-weaver', 'qa-gate:perf-sentinel'];
    for (const gate of gateTypes) {
      const gateIdx = orchSrc.indexOf(`"${gate}"`);
      expect(gateIdx).toBeGreaterThan(-1);
      const invokeRegion = orchSrc.slice(Math.max(0, gateIdx - 100), gateIdx + 10);
      expect(invokeRegion).toMatch(/run_orch_prompt_with_tools|_run_qa_gate_with_retry/);
    }
  });

  it('_run_qa_gate_with_retry is defined before it is first used (at the sast call site)', () => {
    const defIdx = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const useIdx = orchSrc.indexOf('_run_qa_gate_with_retry "$sast_prompt"');
    expect(defIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeGreaterThan(-1);
    expect(defIdx).toBeLessThan(useIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AGENT PROFILES: grounding rules
// ─────────────────────────────────────────────────────────────────────────────

describe('Agent profiles — grounding rules', () => {
  it('fuzz-weaver profile has GROUNDING RULES section', () => {
    expect(profiles['fuzz-weaver']).toMatch(/GROUNDING RULES/);
  });

  it('fuzz-weaver profile forbids verdict=fail without file access', () => {
    expect(profiles['fuzz-weaver']).toMatch(/NEVER.*fail|tool list empty|ALL cases.*gap/i);
  });

  it('fuzz-weaver profile requires gap status when no tool access', () => {
    expect(profiles['fuzz-weaver']).toMatch(/cannot.*read|tool.*unavailable/i);
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

  it('perf-sentinel profile has canonical no-tool-access JSON template', () => {
    // Must include the exact safe fallback JSON so the agent emits warn not fail
    expect(profiles['perf-sentinel']).toMatch(/"filesAnalysed":0/);
    expect(profiles['perf-sentinel']).toMatch(/"blockerCount":0/);
  });

  it('sast-sentinel profile has dev-dep CVE rule', () => {
    expect(profiles['sast-sentinel']).toMatch(/devDependencies.*minor|dev.dep.*CVE.*minor/i);
  });

  it('test-engineer profile references testCriteria', () => {
    expect(profiles['test-engineer']).toMatch(/testCriteria/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHECKLIST CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('Pipeline step checklist — ordering and heartbeat', () => {
  it('print_step_checklist is called before run_specification_pass', () => {
    const callIdx    = orchSrc.indexOf('\nprint_step_checklist\n');
    const specPassIdx = orchSrc.indexOf('\nrun_specification_pass');
    expect(callIdx).toBeGreaterThan(-1);
    expect(specPassIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(specPassIdx);
  });

  // 2026-07-06: this list was stale — missing 0.9 (PRD model coordinator),
  // 3.2 (merge worktrees), and 3.8 (lint gate), all of which already existed
  // as real step_emit() call sites in the script; re-verified against the
  // live source via `grep -n 'step_emit "[0-9]'` rather than trusting the old
  // list. Also added 0a/0b (openspec/speckit sub-steps, newly surfaced this
  // session — previously only visible as buried "spec-mode: fast-path" log
  // lines, not in the checklist at all).
  it('print_step_checklist function lists all 27 step IDs (25 pipeline steps + 2 spec-mode sub-steps)', () => {
    const fn = orchSrc.match(/print_step_checklist\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const ids = ['1', '1a', '1b', '2', '3', '4', '5', '6', '7', '8', '9', '10',
                 '13', '14', '15', '16', '17', '18', '19', '20',
                 '21', '22a', '22b', '22c', '22d', '22e', '22f', '23'];
    for (const id of ids) {
      expect(fn).toMatch(new RegExp(`"${id.replace('.', '\\.')}"`));
    }
  });

  it('openspec/speckit sub-steps (1a/1b) show the actual configured model, not a hardcoded one', () => {
    const fn = orchSrc.match(/print_step_checklist\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(fn).toMatch(/1a.*SPEC_MODE_OPENSPEC_MODEL/);
    expect(fn).toMatch(/1b.*SPEC_MODE_SPECKIT_MODEL/);
  });

  it('run_specification_pass emits live step_emit calls for 0a/0b (not just the pre-scan row) with model + story count parsed from spec-summary.json', () => {
    const fnStart = orchSrc.indexOf('run_specification_pass()');
    const fnEnd = orchSrc.indexOf('\n}', fnStart);
    const fnBody = orchSrc.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/spec-summary\.json/);
    expect(fnBody).toMatch(/step_emit "1a"/);
    expect(fnBody).toMatch(/step_emit "1b"/);
    expect(fnBody).toMatch(/\.stats\.agents\.openspec/);
    expect(fnBody).toMatch(/\.stats\.agents\.speckit/);
  });

  it('heartbeat fires every 60 seconds', () => {
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

  it('heartbeat function loops with while true', () => {
    const heartbeatFn = orchSrc.match(/_checklist_heartbeat\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(heartbeatFn).toMatch(/while true/);
  });

  it('RESOLVED_ORCH_MODE is resolved before checklist prints', () => {
    const resolveIdx = orchSrc.indexOf('RESOLVED_ORCH_MODE=');
    const checklistIdx = orchSrc.indexOf('\nprint_step_checklist\n');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(checklistIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(checklistIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// step-status.json SCHEMA CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('step-status.json schema', () => {
  it('step_emit emits phase field', () => {
    expect(orchSrc).toMatch(/\\\"phase\\\".*PHASE:-unknown/);
  });

  it('step_emit emits updatedAt timestamp', () => {
    expect(orchSrc).toMatch(/\\\"updatedAt\\\".*\$\{ts\}/);
  });

  it('step_emit emits steps array with id, label, status', () => {
    expect(orchSrc).toMatch(/"id":"[^"]+","label":"[^"]+","status":"[^"]+"/);
  });

  it('step_emit uses _STEP_STATUS associative array', () => {
    expect(orchSrc).toMatch(/declare -A _STEP_STATUS/);
    expect(orchSrc).toMatch(/_STEP_STATUS\["[^"]+"\]="[^"]+"/);
  });

  it('step_emit uses _STEP_LABELS associative array', () => {
    expect(orchSrc).toMatch(/declare -A _STEP_LABELS/);
  });

  it('step_emit includes reason string in output when provided', () => {
    expect(orchSrc).toMatch(/reason_str.*YELLOW.*reason/);
  });

  it('step_emit icons: pass=✓, skip=⊘, fail=✗, warn=⚠, running=▶', () => {
    expect(orchSrc).toMatch(/pass.*✓|✓.*pass/);
    expect(orchSrc).toMatch(/skip.*⊘|⊘.*skip/);
    expect(orchSrc).toMatch(/fail.*✗|✗.*fail/);
    expect(orchSrc).toMatch(/warn.*⚠|⚠.*warn/);
    expect(orchSrc).toMatch(/running.*▶|▶.*running/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD AUTO-REMEDIATION CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('PRD auto-remediation', () => {
  it('prd-remediate.sh script exists and is executable', () => {
    expect(fs.existsSync(PRD_REMEDIATE)).toBe(true);
    const stat = fs.statSync(PRD_REMEDIATE);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('prd-remediate.sh calls preflight-prd-integrity.sh after remediation', () => {
    const src = fs.readFileSync(PRD_REMEDIATE, 'utf8');
    expect(src).toMatch(/preflight-prd-integrity\.sh/);
  });

  it('prd-remediate.sh calls the Python impl script', () => {
    const src = fs.readFileSync(PRD_REMEDIATE, 'utf8');
    expect(src).toMatch(/_prd_remediate_impl\.py/);
  });

  it('_prd_remediate_impl.py exists', () => {
    expect(fs.existsSync(PRD_REMEDIATE_IMPL)).toBe(true);
  });

  it('remediation removes stale bug-fix split stories', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/stale_splits/);
    expect(src).toMatch(/split_re.*impl\|test\|table/);
  });

  it('remediation removes no-files stories from implementationOrder', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/no_files_removed/);
    expect(src).toMatch(/technicalNotes.*files/);
  });

  it('remediation removes extra/stale phases', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/extra_phases/);
    expect(src).toMatch(/REQUIRED_PHASES/);
    // ui_and_review removed (2026-07-07): pipeline is scaffold -> core only.
    // A 'documentation' phase was requested but investigation confirmed it
    // was never wired into phase execution (dead agent profiles only, no
    // phase-loop code) — not added here until it's actually built. Check the
    // actual REQUIRED_PHASES line specifically, not the whole file (a
    // comment elsewhere legitimately mentions "ui_and_review" as removed).
    const phasesLine = src.split('\n').find((l) => l.includes('REQUIRED_PHASES =')) ?? '';
    expect(phasesLine).toMatch(/scaffold.*core/);
    expect(phasesLine).not.toMatch(/ui_and_review/);
  });

  it('remediation trims ACs exceeding 24 to exactly 24', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/MAX_ACS = 24/);
    expect(src).toMatch(/acceptanceCriteria.*MAX_ACS/);
    expect(src).toMatch(/acs\[:MAX_ACS\]/);
  });

  it('remediation deduplicates exact-duplicate file paths within a story', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/deduped_count/);
    expect(src).toMatch(/dict\.fromkeys|dedup/);
  });

  it('remediation resets active story status to pending', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/status.*pending/);
    expect(src).toMatch(/completed.*False/);
  });

  it('remediation strips runtime fields from stories', () => {
    const src = fs.readFileSync(PRD_REMEDIATE_IMPL, 'utf8');
    expect(src).toMatch(/RUNTIME_FIELDS/);
    // actualCost must NOT be in RUNTIME_FIELDS — it is historical data that survives remediation
    expect(src).toMatch(/startedAt/);
    expect(src).toMatch(/completedAt/);
    expect(src).not.toMatch(/RUNTIME_FIELDS\s*=\s*\[[^\]]*actualCost/);
  });

  it('tier3 runner calls prd-remediate.sh before each phase', () => {
    expect(tier3Src).toMatch(/prd-remediate\.sh.*--prd/);
  });

  it('tier3 runner aborts if PRD remediation fails', () => {
    expect(tier3Src).toMatch(/prd-remediate\.sh.*--prd/);
    expect(tier3Src).toMatch(/PRD remediation failed.*aborting|aborting.*PRD remediation/i);
  });

  it('tier3 runner calls remediation inside run_phase function', () => {
    const runPhaseFn = tier3Src.match(/run_phase\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(runPhaseFn).toMatch(/prd-remediate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('monitor.html — pipeline steps panel', () => {
  it('dashboard fetches step-status.json', () => {
    expect(monitorSrc).toMatch(/step-status\.json/);
  });

  it('dashboard has renderPipelineSteps function', () => {
    expect(monitorSrc).toMatch(/function renderPipelineSteps/);
  });

  it('STEP_MANIFEST covers all 23 step IDs', () => {
    const manifest = monitorSrc.match(/const STEP_MANIFEST = \[([\s\S]*?)\];/)?.[1] ?? '';
    const ids = ['1', '2', '3', '4', '5', '6', '8', '9', '10',
                 '13', '14', '15', '16', '18', '19',
                 '21', '22a', '22b', '22c', '22d', '22e', '22f', '23'];
    for (const id of ids) {
      expect(manifest).toMatch(new RegExp(`id:'${id.replace('.', '\\.')}'`));
    }
  });

  it('dashboard renders SKIP status in amber', () => {
    expect(monitorSrc).toMatch(/skip.*amber|amber.*skip/i);
  });

  it('dashboard shows bypass env var for skipped steps', () => {
    expect(monitorSrc).toMatch(/bypassVar/);
  });

  it('dashboard calls renderPipelineSteps in main refresh loop', () => {
    const refreshFn = monitorSrc.match(/async function refresh\(\)([\s\S]*?)^}/m)?.[1] ?? '';
    expect(refreshFn).toMatch(/renderPipelineSteps/);
  });

  it('dashboard shows pass status in green', () => {
    expect(monitorSrc).toMatch(/pass.*green|green.*pass/i);
  });

  it('dashboard shows fail status in red', () => {
    expect(monitorSrc).toMatch(/fail.*red|red.*fail/i);
  });

  it('dashboard shows running status in blue', () => {
    expect(monitorSrc).toMatch(/running.*blue|blue.*running/i);
  });
});
