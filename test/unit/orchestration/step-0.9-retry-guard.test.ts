/**
 * Step 0.9 (PRD model coordinator) — retry-on-violation guard.
 *
 * MC_REVIEW_PY already computed a clean, deterministic field-allowlist
 * violation signal (model/aiProvider/reasoningEffort only) — it just used
 * to revert-and-give-up on 'fail' with no attempt to tell the model what it
 * did wrong and retry. This wraps the existing single call + MC_REVIEW_PY
 * check in a 3-attempt loop, reusing MC_REVIEW_PY unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

// Same heredoc-aware extraction as step-0.5-retry-guard.test.ts — this
// section also embeds heredocs (ENDPROMPT_MC, MC_REVIEW_PY, MC_FALLBACK_PY)
// whose python dict/list literals can have a closing brace alone on a line.
function extractSectionByAnchors(startAnchor: string, endAnchor: string): string {
  const startIdx = orchSrc.indexOf(startAnchor);
  const endIdx = orchSrc.indexOf(endAnchor, startIdx);
  if (startIdx === -1 || endIdx === -1) throw new Error('anchor not found');
  return orchSrc.slice(startIdx, endIdx);
}

describe('Step 0.9 — static wiring', () => {
  const section = extractSectionByAnchors(
    'step_emit "0.9" "running"',
    'step_emit "0.9" "pass" "Step 0.9: PRD model coordinator"'
  );

  it('wraps the coordinator call in a 3-attempt retry loop', () => {
    expect(section).toMatch(/for _mc_attempt in 1 2 3; do/);
  });

  it('still reuses MC_REVIEW_PY\'s existing ALLOWED_FIELDS check unchanged', () => {
    expect(section).toMatch(/ALLOWED_FIELDS = \{'model', 'aiProvider', 'reasoningEffort'\}/);
  });

  it('logs outcomes via the shared _log_guarded_step_retry helper (double-write to per-run + persistent history)', () => {
    expect(section).toMatch(/_log_guarded_step_retry "\$\(jq -n -c/);
  });
});

// _log_guarded_step_retry/_epam_prompt_version — shared helpers (2026-07-13)
// that this call site now delegates to for the actual
// "guarded-step-retries.jsonl" write. The REAL-execution harness below must
// define them too, or the call site silently no-ops.
function extractHelperFunctionBody(name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(orchSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}

describe('Step 0.9 — REAL execution', () => {
  function run(opts: { violateForAttempts: number }): { finalPrd: any; retriesLog: any[] } {
    const dir = mkdtempSync(join(tmpdir(), 'step09-retry-'));
    const prdPath = join(dir, 'prd.json');
    const profilesPath = join(dir, 'profiles.json');
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });

    const initialPrd = {
      implementationOrder: { core: ['SKY-002'] },
      stories: [{ id: 'SKY-002', status: 'pending', technicalNotes: { files: ['src/a.ts'] } }],
    };
    writeFileSync(prdPath, JSON.stringify(initialPrd));
    writeFileSync(profilesPath, JSON.stringify({ 'prd-model-coordinator': 'assign models' }));

    // Extract the whole Step 0.9 block as a standalone script (it's
    // top-level code, not a function) — from its header comment through the
    // final assert calls, then swap the asserts for no-ops in the harness.
    const startAnchor = '# Step 0.9: PRD model coordinator';
    const endAnchor = 'assert_no_illegitimate_deprecation "presplit" "Step 0.9: PRD model coordinator"';
    const startIdx = orchSrc.indexOf(startAnchor);
    const endIdx = orchSrc.indexOf(endAnchor) + endAnchor.length;
    const block = orchSrc.slice(startIdx, endIdx);

    const stub = `
_mc_call_count_file=${JSON.stringify(join(dir, 'call-count'))}
AI_RUNNER_CMD() { :; }
export -f AI_RUNNER_CMD 2>/dev/null || true
`;

    // AI_RUNNER_CMD is invoked as "$AI_RUNNER_CMD" (a plain variable, not a
    // function call) in the real script, so stub it as a real executable.
    const aiRunnerStub = join(dir, 'ai-run-stub.sh');
    writeFileSync(
      aiRunnerStub,
      [
        '#!/usr/bin/env bash',
        `n=0; [ -f ${JSON.stringify(join(dir, 'call-count'))} ] && n=$(cat ${JSON.stringify(join(dir, 'call-count'))})`,
        'n=$((n+1))',
        `echo "$n" > ${JSON.stringify(join(dir, 'call-count'))}`,
        `if [ "$n" -le ${opts.violateForAttempts} ]; then`,
        `  jq '(.stories[] | select(.id == "SKY-002")).status = "completed"' ${JSON.stringify(prdPath)} > ${JSON.stringify(prdPath)}.tmp && mv ${JSON.stringify(prdPath)}.tmp ${JSON.stringify(prdPath)}`,
        'else',
        `  jq '(.stories[] | select(.id == "SKY-002")).model = "moonshotai/kimi-k2" | (.stories[] | select(.id == "SKY-002")).aiProvider = "qwen" | (.stories[] | select(.id == "SKY-002")).reasoningEffort = "medium"' ${JSON.stringify(prdPath)} > ${JSON.stringify(prdPath)}.tmp && mv ${JSON.stringify(prdPath)}.tmp ${JSON.stringify(prdPath)}`,
        'fi',
        'echo \'{"assigned_count": 1}\'',
      ].join('\n'),
    );
    execFileSync('chmod', ['+x', aiRunnerStub]);

    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
      `AUTOMATION_DIR=${JSON.stringify(dir)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      `AI_RUNNER_CMD=${JSON.stringify(aiRunnerStub)}`,
      'CLAUDE_CMD=""',
      'log() { echo "LOG: $*" >&2; }',
      'info() { echo "INFO: $*" >&2; }',
      'warning() { echo "WARN: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'error() { echo "ERROR: $*" >&2; }',
      'step_emit() { echo "STEP_EMIT: $*" >&2; }',
      'assert_no_story_ids_lost() { :; }',
      'assert_no_story_ids_gained() { :; }',
      'assert_no_illegitimate_deprecation() { :; }',
      // History dir redirected to this test's own throwaway dir -- never
      // touch the real orchestrations/logs/guarded-step-retries-history.jsonl.
      extractHelperFunctionBody('_epam_prompt_version'),
      extractHelperFunctionBody('_log_guarded_step_retry').replace(
        /\$SCRIPT_DIR\/\.\.\/logs/g,
        join(dir, 'history-logs'),
      ),
      `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
      block,
    ].join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);

    execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    const finalPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const retriesLogPath = join(logDir, 'guarded-step-retries.jsonl');
    let retriesLog: any[] = [];
    try {
      retriesLog = readFileSync(retriesLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      retriesLog = [];
    }
    rmSync(dir, { recursive: true, force: true });
    return { finalPrd, retriesLog };
  }

  it('REPRODUCES the live defect: an out-of-scope field write (status) is caught and reverted after 3 attempts', () => {
    const { finalPrd, retriesLog } = run({ violateForAttempts: 3 });
    const sky002 = finalPrd.stories.find((s: any) => s.id === 'SKY-002');
    expect(sky002.status).toBe('pending'); // reverted
    expect(retriesLog[0].outcome).toBe('reverted');
    expect(retriesLog[0].attempts).toBe(3);
  });

  it('retries then succeeds: violates on attempt 1, behaves on attempt 2', () => {
    const { finalPrd, retriesLog } = run({ violateForAttempts: 1 });
    const sky002 = finalPrd.stories.find((s: any) => s.id === 'SKY-002');
    expect(sky002.status).toBe('pending');
    expect(sky002.model).toBe('moonshotai/kimi-k2');
    expect(retriesLog[0].outcome).toBe('pass');
    expect(retriesLog[0].attempts).toBe(2);
  });
});
