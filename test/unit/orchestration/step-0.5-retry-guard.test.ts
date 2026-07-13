/**
 * run_pre_phase_assessment() (Step 0.5) — retry-on-violation guard.
 *
 * Root cause this addresses: Step 0.5 has full tool-write access to prd.json
 * and profiles.json, is told (in its own prompt) it may only add to
 * profiles.json or change agentRole/model/aiProvider/reasoningEffort fields
 * on stories, but has caused 3 confirmed live corruption incidents in one
 * night (story-ID loss, illegitimate deprecation, spurious field writes) —
 * all previously only caught AFTER the fact by generic downstream guards
 * (assert_no_story_ids_lost/gained, assert_no_illegitimate_deprecation) with
 * no attempt to tell the model what it did wrong and let it try again.
 *
 * Fix: a new deterministic PRD-side field-allowlist checker
 * (PFA_PRD_DIFF_PY, mirroring Step 0.9's existing MC_REVIEW_PY), plus a
 * 3-attempt retry loop around the whole call — on violation (profiles
 * content OR PRD fields), both files revert to the pre-attempt snapshot and
 * a corrective note naming the violation is fed into the next attempt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

// Heredoc-aware extraction: a naive `indexOf('\n}')` truncates mid-body the
// moment ANY embedded heredoc (this function has three: PROMPT_HEADER,
// PFA_DIFF_PY, PFA_PRD_DIFF_PY) contains a python dict/set literal whose
// closing brace sits alone on its own line at column 0 — which looks
// identical to the bash function's own closing brace. Track heredoc state
// line-by-line so only a bare `}` OUTSIDE any heredoc counts as the end.
function extractFunctionBody(name: string): string {
  const lines = orchSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`No function definition found for ${name}()`);
  let inHeredoc: string | null = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (inHeredoc !== null) {
      if (line === inHeredoc) inHeredoc = null;
      continue;
    }
    const heredocMatch = line.match(/<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?/);
    if (heredocMatch) {
      inHeredoc = heredocMatch[1];
      continue;
    }
    if (line === '}') {
      return lines.slice(startIdx, i + 1).join('\n');
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('run_pre_phase_assessment() — static wiring', () => {
  const fnBody = extractFunctionBody('run_pre_phase_assessment');

  it('wraps the assessment call in a 3-attempt retry loop', () => {
    expect(fnBody).toMatch(/for _pfa_attempt in 1 2 3; do/);
  });

  it('defines the new PRD-side field-allowlist checker (PFA_PRD_DIFF_PY)', () => {
    expect(fnBody).toMatch(/PFA_PRD_DIFF_PY/);
    expect(fnBody).toMatch(/ALLOWED_FIELDS = \{'agentRole', 'model', 'aiProvider', 'reasoningEffort'\}/);
  });

  it('logs outcomes to guarded-step-retries.jsonl', () => {
    expect(fnBody).toMatch(/guarded-step-retries\.jsonl/);
  });
});

describe('run_pre_phase_assessment() — REAL execution', () => {
  function run(opts: {
    // How many times the stubbed run_orch_prompt_with_tools should
    // introduce an out-of-scope field violation before behaving (0 = never
    // violates, i.e. passes immediately).
    violateForAttempts: number;
  }): { stdout: string; finalPrd: any; finalProfiles: any; retriesLog: any[] } {
    const dir = mkdtempSync(join(tmpdir(), 'step05-retry-'));
    const prdPath = join(dir, 'prd.json');
    const profilesPath = join(dir, 'profiles.json');
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });

    const initialPrd = {
      implementationOrder: { core: ['SKY-002'] },
      stories: [
        { id: 'SKY-002', status: 'pending', agentRole: 'typescript-engineer', technicalNotes: { files: ['src/a.ts'] } },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(initialPrd));
    writeFileSync(profilesPath, JSON.stringify({ 'typescript-engineer': 'write TS code' }));

    const fnBody = extractFunctionBody('run_pre_phase_assessment');
    const scriptPath = join(dir, 'run.sh');

    // Stub run_orch_prompt_with_tools: on attempts <= violateForAttempts,
    // corrupt an out-of-scope field (status); afterwards, behave (only
    // touch agentRole, the allowed field).
    const stub = `
_pfa_call_count_file=${JSON.stringify(join(dir, 'call-count'))}
run_orch_prompt_with_tools() {
  local n=0
  [ -f "$_pfa_call_count_file" ] && n=$(cat "$_pfa_call_count_file")
  n=$((n+1))
  echo "$n" > "$_pfa_call_count_file"
  if [ "$n" -le ${opts.violateForAttempts} ]; then
    jq '(.stories[] | select(.id == "SKY-002")).status = "deprecated"' ${JSON.stringify(prdPath)} > ${JSON.stringify(prdPath)}.tmp && mv ${JSON.stringify(prdPath)}.tmp ${JSON.stringify(prdPath)}
  else
    jq '(.stories[] | select(.id == "SKY-002")).agentRole = "test-engineer"' ${JSON.stringify(prdPath)} > ${JSON.stringify(prdPath)}.tmp && mv ${JSON.stringify(prdPath)}.tmp ${JSON.stringify(prdPath)}
  fi
  return 0
}
`;

    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `AGENT_PROFILES_FILE=${JSON.stringify(profilesPath)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`,
      `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
      'PHASE=core',
      'ORCH_GATE_PROVIDER=""', // disables the profiles-content LLM reviewer sub-call — isolates this test to the new PRD checker
      'PRD_REL="prd.json"',
      'log() { echo "LOG: $*" >&2; }',
      'info() { echo "INFO: $*" >&2; }',
      'warning() { echo "WARN: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'error() { echo "ERROR: $*" >&2; }',
      'step_emit() { echo "STEP_EMIT: $*" >&2; }',
      stub,
      fnBody,
      'run_pre_phase_assessment core',
    ].join('\n');
    writeFileSync(scriptPath, script);

    const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).toString();
    const finalPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const finalProfiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
    const retriesLogPath = join(logDir, 'guarded-step-retries.jsonl');
    let retriesLog: any[] = [];
    try {
      retriesLog = readFileSync(retriesLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      retriesLog = [];
    }
    rmSync(dir, { recursive: true, force: true });
    return { stdout, finalPrd, finalProfiles, retriesLog };
  }

  it('REPRODUCES the exact live defect: an out-of-scope field write (status) is caught, and self-heals to pending WITHOUT ever needing a retry to prove the checker fires', () => {
    const { finalPrd, retriesLog } = run({ violateForAttempts: 3 }); // violates on all 3 attempts
    const sky002 = finalPrd.stories.find((s: any) => s.id === 'SKY-002');
    expect(sky002.status).toBe('pending'); // reverted, not left as "deprecated"
    expect(retriesLog[0].outcome).toBe('reverted');
    expect(retriesLog[0].attempts).toBe(3);
  });

  it('retries then succeeds: violates on attempt 1, behaves (agentRole-only) on attempt 2 — final state reflects the GOOD attempt', () => {
    const { finalPrd, retriesLog } = run({ violateForAttempts: 1 });
    const sky002 = finalPrd.stories.find((s: any) => s.id === 'SKY-002');
    expect(sky002.status).toBe('pending');
    expect(sky002.agentRole).toBe('test-engineer'); // the legitimate attempt-2 change was kept
    expect(retriesLog[0].outcome).toBe('pass');
    expect(retriesLog[0].attempts).toBe(2);
  });

  it('never violates: passes on the first attempt, no retries needed', () => {
    const { finalPrd, retriesLog } = run({ violateForAttempts: 0 });
    const sky002 = finalPrd.stories.find((s: any) => s.id === 'SKY-002');
    expect(sky002.agentRole).toBe('test-engineer');
    expect(retriesLog[0].outcome).toBe('pass');
    expect(retriesLog[0].attempts).toBe(1);
  });
});
