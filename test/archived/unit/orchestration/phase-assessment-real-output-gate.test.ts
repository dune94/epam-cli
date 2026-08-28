/**
 * Live gap (found 2026-07-07, tier3 relaunch, core phase, log lines
 * ~3708-3823): the Step 6/3.5 post-phase assessment agent tried to read
 * `orchestrations/logs/phase-cost.jsonl` at wrong relative paths, couldn't
 * find either, and instead of failing loudly asked a chat-style
 * "Option A/B/C -- which would you like?" question it has no way of
 * getting answered mid-pipeline. Immediately after, the orchestrator
 * logged `[SUCCESS] Phase assessment completed` -- it only ever checked
 * the tool call's EXIT CODE, never whether a real assessment record was
 * actually written.
 *
 * Full agent audit, 2026-07-31 (mock1 investigation): this step was later
 * rewritten entirely. It no longer hands the agent any file path to read at
 * all — the cost-log dedup/cross-reference/arithmetic now happens
 * deterministically in a python precompute block (ASSESS_PRECOMPUTE_PY),
 * and the finished summary JSON is injected directly into the prompt. The
 * agent gets NO tools (not even read_file) and its only job is judgment:
 * emit {"notes":...,"agent_recommendations":[...],"role_reassignments":[...]}.
 * The orchestrator (not the agent) deterministically appends the
 * assessment record and applies any role reassignment (ASSESS_APPLY_PY),
 * mirroring story-ac-remediator's deterministic-apply pattern. This
 * structurally eliminates the original path-guessing failure mode (there is
 * no path left to guess), but the REAL-EVIDENCE requirement this file
 * exists to enforce still applies in its new form: a plain "I have a
 * question" non-JSON response must not be silently treated as success.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(orchSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}

// Isolates just the heredoc prompt text sent to the LLM -- NOT the whole
// function body, which legitimately contains explanatory comments that
// mention the old, now-fixed literal path as historical context. The
// actual behavioral guarantee this test file cares about is "the PROMPT
// itself doesn't contain a guessable literal," not "the word never appears
// anywhere in a comment."
function extractPromptHeredoc(fnBody: string): string {
  const start = fnBody.indexOf('cat << PROMPT_EOF');
  const end = fnBody.indexOf('\nPROMPT_EOF', start);
  if (start === -1 || end === -1) throw new Error('Could not locate PROMPT_EOF heredoc');
  return fnBody.slice(start, end);
}

describe('run_phase_assessment() prompt — no guessable literal paths, precomputed data injected (static)', () => {
  const fnBody = extractFunctionBody('run_phase_assessment');
  const promptText = extractPromptHeredoc(fnBody);

  it('does not hardcode the literal relative path "orchestrations/logs/phase-cost.jsonl" in the prompt', () => {
    expect(promptText).not.toMatch(/orchestrations\/logs\/phase-cost\.jsonl/);
  });

  it('does not hardcode the literal relative path "orchestrations/logs/phase-skill-assessments.jsonl" in the prompt', () => {
    expect(promptText).not.toMatch(/orchestrations\/logs\/phase-skill-assessments\.jsonl/);
  });

  it('does not hardcode the literal relative path "orchestrations/logs/phase-improvements" in the prompt', () => {
    expect(promptText).not.toMatch(/orchestrations\/logs\/phase-improvements/);
  });

  it('does not ask the agent to read any file at all — the precomputed summary is injected directly', () => {
    expect(promptText).toMatch(/\$\{_pa_summary\}/);
    expect(promptText).toMatch(/do not ask to see any file/);
  });

  it('grants the agent no tools — this is judgment-only, matching openspec/speckit', () => {
    expect(fnBody).not.toMatch(/run_orch_prompt_with_tools/);
    expect(fnBody).toMatch(/you have no tools and do not need any/);
  });
});

describe('Step 6 call site — run_phase_assessment() failure must not abort the whole script (static)', () => {
  // Live defect (found 2026-07-12, same night the real-evidence gate above
  // shipped): Step 3.5's call site wraps run_phase_assessment in
  // `if run_phase_assessment ...; then ... else ... fi` (safe under `set -e`
  // regardless of return code), but Step 6's call site was a bare
  // `run_phase_assessment "$PHASE"` with no if/else. Under this script's
  // `set -e`, a bare call returning 1 (which the real-evidence gate now does
  // whenever the LAST, purely informational assessment produces no new
  // record) aborts the ENTIRE run-agent-orchestration.sh process --
  // confirmed live: a scaffold phase that had already fully completed and
  // received a GO phase-gate decision was killed with "Phase 'scaffold'
  // failed (exit 1) -- aborting pipeline" by tier3-travel-app-run.sh, over
  // nothing but Step 6's assessment call.
  it('Step 24 (final assessment) wraps run_phase_assessment in an if/else, not a bare call', () => {
    const idx = orchSrc.indexOf('Step 24: Running final post-phase assessment');
    const block = orchSrc.slice(idx, idx + 1400);
    expect(block).toMatch(/if run_phase_assessment "\$PHASE"; then/);
    expect(block).not.toMatch(/\n\s*run_phase_assessment "\$PHASE"\s*\n/);
  });
});

describe('run_phase_assessment() — REAL execution: verifies a genuine judgment response before reporting success', () => {
  function run(opts: {
    phaseId: string;
    existingAssessmentLines?: string[];
    agentResponse: string; // raw stdout the stubbed run_orch_prompt call produces
    fakeOrchPromptExitCode?: number;
  }): { rc: number; logOutput: string; assessmentFileContent: string } {
    const dir = mkdtempSync(join(tmpdir(), 'phase-assessment-'));
    try {
      const costFile = join(dir, 'phase-cost.jsonl');
      writeFileSync(
        costFile,
        `{"phase_id":${JSON.stringify(opts.phaseId)},"story_id":"SKY-001","started_at":"2026-07-12T00:00:00Z","ended_at":"2026-07-12T00:05:00Z","task_cost_usd":0.1}\n`,
      );
      const assessmentFile = join(dir, 'phase-skill-assessments.jsonl');
      writeFileSync(assessmentFile, (opts.existingAssessmentLines ?? []).join('\n') + (opts.existingAssessmentLines?.length ? '\n' : ''));
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          stories: [{ id: 'SKY-001', status: 'completed', completed: true, agentRole: 'typescript-engineer', description: 'a story' }],
          implementationOrder: { [opts.phaseId]: ['SKY-001'] },
        }),
      );

      const fnBody = extractFunctionBody('run_phase_assessment');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `LOG_DIR=${JSON.stringify(dir)}`,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          `PRD_FILE=${JSON.stringify(prdFile)}`,
          'log() { echo "LOG: $*" >&2; }',
          'info() { echo "INFO: $*" >&2; }',
          'warning() { echo "WARN: $*" >&2; }',
          'success() { echo "SUCCESS: $*" >&2; }',
          'error() { echo "ERROR: $*" >&2; }',
          '_build_skill_domain_guidance() { echo ""; }',
          // Stub the actual LLM call: simulates either a genuine judgment
          // response (matching the new prompt's required JSON shape) or the
          // live "asked a question instead of doing the work" failure mode.
          `run_orch_prompt() {`,
          `  cat << 'AGENT_RESPONSE_EOF'`,
          opts.agentResponse,
          `AGENT_RESPONSE_EOF`,
          `  return ${opts.fakeOrchPromptExitCode ?? 0}`,
          `}`,
          fnBody,
          `run_phase_assessment ${JSON.stringify(opts.phaseId)}`,
          'echo "RC=$?"',
        ].join('\n'),
      );
      const stderrPath = join(dir, 'stderr.log');
      const wrapperPath = join(dir, 'run-wrapper.sh');
      writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
      let stdout = '';
      try {
        stdout = execFileSync('bash', [wrapperPath], { encoding: 'utf8' });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString();
      }
      const combined = stdout + readFileSync(stderrPath, 'utf8');
      const rc = parseInt(combined.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      const assessmentFileContent = readFileSync(assessmentFile, 'utf8');
      return { rc, logOutput: combined, assessmentFileContent };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the live gap in its new form: agent asks a question instead of valid JSON, gets no silent success', () => {
    const { rc, logOutput, assessmentFileContent } = run({
      phaseId: 'core',
      agentResponse: 'Option A: skip. Option B: retry. Which would you like?',
    });
    expect(rc).toBe(1);
    expect(logOutput).toMatch(/no valid JSON/);
    expect(logOutput).toMatch(/no assessment record written/);
    expect(assessmentFileContent).toBe('');
  });

  it('reports success and appends a genuine assessment record when the agent returns valid judgment JSON', () => {
    const { rc, assessmentFileContent } = run({
      phaseId: 'core',
      agentResponse: '{"notes":"all good","agent_recommendations":[],"role_reassignments":[]}',
    });
    expect(rc).toBe(0);
    const record = JSON.parse(assessmentFileContent.trim());
    expect(record.phase_id).toBe('core');
    // The written numbers come from the deterministic precompute, not the
    // agent's own arithmetic — the agent never had the cost file at all.
    expect(record.actual_minutes).toBeCloseTo(5, 1);
    expect(record.actual_cost_usd).toBeCloseTo(0.1, 4);
    expect(record.notes).toBe('all good');
  });

  it('still fails when the underlying tool call itself returns non-zero, regardless of response content', () => {
    const { rc, assessmentFileContent } = run({
      phaseId: 'core',
      agentResponse: '{"notes":"all good","agent_recommendations":[],"role_reassignments":[]}',
      fakeOrchPromptExitCode: 1,
    });
    expect(rc).toBe(1);
    expect(assessmentFileContent).toBe('');
  });
});
