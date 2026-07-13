/**
 * Live gap (found 2026-07-07, tier3 relaunch, core phase, log lines
 * ~3708-3823): the Step 6/3.5 post-phase assessment agent tried to read
 * `orchestrations/logs/phase-cost.jsonl` at wrong relative paths
 * (`orchestrations/logs/` and `../ai/epam-cli/orchestrations/`), couldn't
 * find either, and instead of failing loudly asked a chat-style
 * "Option A/B/C -- which would you like?" question it has no way of
 * getting answered mid-pipeline. Immediately after, the orchestrator
 * logged `[SUCCESS] Phase assessment completed` -- it only ever checked
 * run_orch_prompt_with_tools's EXIT CODE, never whether a real assessment
 * record was actually written. The assessment content for that run was
 * worthless (no variance/cost analysis was ever computed), and nothing
 * caught it.
 *
 * ROOT CAUSE of the path-guessing, confirmed by reading the code directly:
 * run_phase_assessment()'s prompt hardcodes the LITERAL STRING
 * "orchestrations/logs/phase-cost.jsonl" -- but LOG_DIR (where the real
 * file lives, $cost_file = "$LOG_DIR/phase-cost.jsonl") is set to
 * "${OUTPUT_DIR:-$AUTOMATION_DIR/logs}", and in the tier3 setup OUTPUT_DIR
 * IS PROJECT_ROOT directly (the target app's own root, not a nested
 * "orchestrations/logs" subdirectory of it) -- so after the agent `cd`s to
 * PROJECT_ROOT (line ~3502), the literal relative path in the prompt
 * points at a directory structure that doesn't exist. The agent was
 * GUESSING because it was handed a made-up path, not a real one.
 *
 * TWO independent fixes:
 * 1. Pass the agent the REAL, already-resolved absolute paths ($cost_file,
 *    $assessment_file, the improvement report path) instead of a
 *    hardcoded relative literal it has to guess is correct.
 * 2. After the call, verify a REAL new assessment record was actually
 *    appended for this phase_id (deterministic, verifiable evidence) --
 *    not just trust the tool call's exit code, which is 0 even when the
 *    agent gave up and asked a question instead of doing the work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

describe('run_phase_assessment() prompt — real absolute paths, not guessable relative literals (static)', () => {
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

  it('the prompt interpolates the real $cost_file variable instead', () => {
    expect(promptText).toMatch(/\$cost_file/);
  });

  it('the prompt interpolates the real $assessment_file variable instead', () => {
    expect(promptText).toMatch(/\$assessment_file/);
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
  it('Step 6 wraps run_phase_assessment in an if/else, not a bare call', () => {
    const idx = orchSrc.indexOf('Step 6: Running final post-phase assessment');
    const block = orchSrc.slice(idx, idx + 1400);
    expect(block).toMatch(/if run_phase_assessment "\$PHASE"; then/);
    expect(block).not.toMatch(/\n\s*run_phase_assessment "\$PHASE"\s*\n/);
  });
});

describe('run_phase_assessment() — REAL execution: verifies a genuine new assessment record before reporting success', () => {
  function run(opts: {
    phaseId: string;
    existingAssessmentLines?: string[];
    fakeOrchPromptWritesRecord: boolean; // simulates whether the stubbed agent call actually appends a real record
    fakeOrchPromptExitCode?: number;
  }): { rc: number; logOutput: string } {
    const dir = mkdtempSync(join(tmpdir(), 'phase-assessment-'));
    try {
      const costFile = join(dir, 'phase-cost.jsonl');
      writeFileSync(costFile, `{"phase_id":${JSON.stringify(opts.phaseId)},"story_id":"SKY-001","started_at":"2026-07-12T00:00:00Z"}\n`);
      const assessmentFile = join(dir, 'phase-skill-assessments.jsonl');
      writeFileSync(assessmentFile, (opts.existingAssessmentLines ?? []).join('\n') + (opts.existingAssessmentLines?.length ? '\n' : ''));

      const fnBody = extractFunctionBody('run_phase_assessment');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `LOG_DIR=${JSON.stringify(dir)}`,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          `PRD_FILE=${JSON.stringify(join(dir, 'prd.json'))}`,
          `PRD_REL="prd.json"`,
          'log() { echo "LOG: $*" >&2; }',
          'info() { echo "INFO: $*" >&2; }',
          'warning() { echo "WARN: $*" >&2; }',
          'success() { echo "SUCCESS: $*" >&2; }',
          // Stub the actual LLM call: simulates either a genuine assessment
          // write (matching the prompt's real instructions) or the live
          // "asked a question instead of writing anything" failure mode.
          `run_orch_prompt_with_tools() {`,
          opts.fakeOrchPromptWritesRecord
            ? `  echo '{"phase_id":${JSON.stringify(opts.phaseId)},"variance_cost_usd":0.1}' >> ${JSON.stringify(assessmentFile)}`
            : `  echo 'Option A: skip. Option B: retry. Which would you like?'`,
          `  return ${opts.fakeOrchPromptExitCode ?? 0}`,
          `}`,
          fnBody,
          `run_phase_assessment ${JSON.stringify(opts.phaseId)}`,
          'echo "RC=$?"',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'prd.json'), '{}');
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
      return { rc, logOutput: combined };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the live gap: agent asks a question instead of writing an assessment, exit code is still 0, current code would report success', () => {
    const { rc, logOutput } = run({ phaseId: 'core', fakeOrchPromptWritesRecord: false, fakeOrchPromptExitCode: 0 });
    // Desired (post-fix): rc=1 / warning, because no real record was written.
    expect(rc).toBe(1);
    expect(logOutput).toMatch(/no new assessment record|did not write/i);
  });

  it('reports success when a genuine new assessment record is actually written', () => {
    const { rc } = run({ phaseId: 'core', fakeOrchPromptWritesRecord: true });
    expect(rc).toBe(0);
  });

  it('does not get fooled by a PRE-EXISTING record for this phase from an earlier run -- must see a NEW one', () => {
    const { rc } = run({
      phaseId: 'core',
      existingAssessmentLines: ['{"phase_id":"core","variance_cost_usd":0.05}'],
      fakeOrchPromptWritesRecord: false,
    });
    expect(rc).toBe(1);
  });

  it('still fails when the underlying tool call itself returns non-zero, regardless of file content', () => {
    const { rc } = run({ phaseId: 'core', fakeOrchPromptWritesRecord: false, fakeOrchPromptExitCode: 1 });
    expect(rc).toBe(1);
  });
});
