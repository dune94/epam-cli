/**
 * Gate-remediation pipeline (run-agent-orchestration.sh, Step 4.2 self-heal)
 * — profile-augmentor targets the OFFENDING STORY's own agentRole, and a
 * successful profile update triggers a retry.
 *
 * Root cause this fixes (found live, 2026-07-09, tier3-travel-app run): a
 * SAST finding (tsconfig.json typo) was correctly grounded to SKY-001A
 * (agentRole: typescript-engineer) and profile-augmentor reported
 * "profile_updated: true (reviewer approved)" — yet the actual
 * profiles.json diff afterward showed NOTHING was added for this finding.
 * Two defects, found by tracing the code against the real diff:
 *
 * Defect A: profile-augmentor's own prompt hardcoded a static
 * gate-name -> profile table ("sast-sentinel finding -> typescript-engineer
 * profile") instead of using the offending story's REAL agentRole — for any
 * story whose role isn't typescript-engineer, this silently updates a
 * profile no agent who touches that story will ever read.
 *
 * Defect B: _remediation_applied (the flag deciding retry vs. hard-stop) was
 * ONLY set when story-ac-remediator added a new AC — a successful,
 * reviewer-approved PROFILE update never set it, so even a correctly-applied
 * fix never led to a retry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const PROFILES_JSON = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const profilesSrc = readFileSync(PROFILES_JSON, 'utf8');

describe('gate-remediation — agentRole targeting (static)', () => {
  it('looks up the offending story\'s real agentRole right after gate-finding-analyst grounds _story_id', () => {
    const idx = orchSrc.indexOf('info "  [gate-finding-analyst] Finding mapped to story: ${_story_id}"');
    const block = orchSrc.slice(idx, idx + 1600);
    expect(block).toMatch(/_story_agent_role=/);
    expect(block).toMatch(/\.agentRole \/\/ "typescript-engineer"/);
  });

  it('threads the looked-up agentRole into the profile-augmentor prompt', () => {
    const idx = orchSrc.indexOf('Profiles file: ${_profiles_file}');
    const block = orchSrc.slice(idx, idx + 300);
    expect(block).toMatch(/\$\{_story_agent_role\}/);
  });

  it('profiles.json["profile-augmentor"] no longer contains the static gate-name -> profile table', () => {
    expect(profilesSrc).not.toMatch(/sast-sentinel finding.*typescript-engineer profile/);
    expect(profilesSrc).toMatch(/Target the profile of the story's OWN agentRole/);
  });
});

describe('gate-remediation — a successful profile update now triggers a retry (static)', () => {
  it('_profile_remediation_applied is declared alongside _remediation_applied', () => {
    const idx = orchSrc.indexOf('local _remediation_applied=0');
    const block = orchSrc.slice(idx, idx + 1000);
    expect(block).toMatch(/local _profile_remediation_applied=0/);
  });

  it('_profile_remediation_applied is set in the reviewer-approved branch', () => {
    const idx = orchSrc.indexOf('success "  [profile-augmentor] Profile updated with new rule for ${_glabel} pattern (reviewer approved)"');
    expect(idx).toBeGreaterThan(-1);
    const block = orchSrc.slice(idx, idx + 220);
    expect(block).toMatch(/_profile_remediation_applied=1/);
  });

  it('the retry condition checks both flags, not just _remediation_applied alone', () => {
    const idx = orchSrc.indexOf('warning "Step 4.2: Remediation applied — caller should reset stories and retry phase"');
    const block = orchSrc.slice(Math.max(0, idx - 200), idx);
    expect(block).toMatch(/_remediation_applied" = "1" \]\s*\|\|\s*\[ "\$_profile_remediation_applied"/);
  });
});

describe('gate-remediation — REAL execution: a profile-only fix (no new AC) now retries instead of hard-stopping', () => {
  function extractRemediationBlock(): string {
    const lines = orchSrc.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === 'if [ "${SKIP_GATE_REMEDIATION:-0}" != "1" ] && [ ${#_failing_logs[@]} -gt 0 ]; then');
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === 'return 1');
    if (startIdx === -1 || endIdx === -1) throw new Error('Could not locate remediation block anchors');
    return lines.slice(startIdx, endIdx + 1).join('\n');
  }

  function run(storyAgentRole: string, acsAdded: number, profileUpdated: boolean): { exitCode: number; stdout: string; promptsReceived: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gate-remediation-profile-target-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({
      stories: [{ id: 'SKY-001A', agentRole: storyAgentRole, technicalNotes: { files: ['tsconfig.json'] } }],
    }));

    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      'gate-finding-analyst': 'stub', 'story-ac-remediator': 'stub',
      'profile-augmentor': 'stub', 'prd-change-reviewer': 'stub',
    }));

    const sastLog = join(dir, 'sast-sentinel-scaffold.log');
    writeFileSync(sastLog, JSON.stringify({
      summary: { blockerCount: 1 },
      findings: [{ severity: 'blocker', rule: 'typescript-compiler-error', file: 'tsconfig.json', line: 11, message: "Unknown compiler option 'resolveJsonMap'" }],
    }));

    // Stub AI_RUNNER_CMD: reads the prompt from stdin, returns canned JSON
    // depending on which of the 4 calls this is (finding-analyst,
    // ac-remediator, profile-augmentor, reviewer-verdict). Also dumps every
    // prompt it receives to a debug file so the test can inspect exactly
    // what profile-augmentor was told, not just its (generic) log output.
    const promptDumpPath = join(dir, 'prompts-received.log');
    const stubPath = join(dir, 'ai-runner-stub.sh');
    writeFileSync(
      stubPath,
      [
        '#!/usr/bin/env bash',
        'prompt=$(cat)',
        `{ echo "=== CALL ==="; echo "$prompt"; } >> ${JSON.stringify(promptDumpPath)}`,
        'if echo "$prompt" | grep -q "Gate:"; then',
        '  echo \'{"gate":"sast-sentinel","story_id":"SKY-001A","file":"tsconfig.json","line":11,"rule":"typescript-compiler-error","message":"bad option","suggested_fix":"rename it"}\'',
        'elif echo "$prompt" | grep -q "Draft the new ACs"; then',
        // Real shape: the orchestrator applies "acs" deterministically, so a
        // fixture claiming acsAdded>0 must actually include that many ACs
        // (fixed 2026-07-11: the orchestrator no longer trusts a bare
        // acs_added count with no corresponding "acs" array).
        `  echo '{"acs_added":${acsAdded},"acs":[${Array.from({ length: acsAdded }, (_, i) => JSON.stringify(`fake AC ${i + 1}`)).join(',')}]}'`,
        'elif echo "$prompt" | grep -q "Check if the pattern is novel"; then',
        // Real shape: profile-augmentor's claim is only trusted if
        // profiles.json actually changed on disk (fixed 2026-07-11 — same
        // "agent narrates a write it never performs" defect class as the
        // story-ac-remediator fix above). A fixture claiming
        // profileUpdated=true must really write the change.
        ...(profileUpdated
          ? [
              // NOTE: the path is a Python single-quoted literal ('${profilesPath}'),
              // NOT JSON.stringify'd — a JSON.stringify'd (double-quoted) path
              // here would collide with the outer bash double-quoted -c "..."
              // argument: bash consumes those quote characters as ITS OWN
              // delimiters rather than passing them through to Python, silently
              // stripping the string quotes Python needs around the path.
              `  python3 -c "import json; p=json.load(open('${profilesPath}')); p['${storyAgentRole}']=p.get('${storyAgentRole}','')+' Never use resolveJsonMap; use resolveJsonModule.'; json.dump(p, open('${profilesPath}', 'w'))"`,
            ]
          : []),
        `  echo '{"profile":"${storyAgentRole}","profile_updated":${profileUpdated ? 'true' : 'false'},"rule_id":"no-resolveJsonMap","rule_text":"Never use resolveJsonMap; use resolveJsonModule."}'`,
        'elif echo "$prompt" | grep -q "STORY: gate-remediation"; then',
        '  echo \'{"verdict":"pass","issues":[],"reason":"ok"}\'',
        'else',
        '  echo \'{}\'',
        'fi',
      ].join('\n')
    );
    chmodSync(stubPath, 0o755);

    const block = extractRemediationBlock();
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'step_emit() { :; }',
      'error() { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      'warning() { echo "WARNING: $*"; }',
      'info() { echo "INFO: $*"; }',
      `AI_RUNNER_CMD=${JSON.stringify(stubPath)}`,
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `AUTOMATION_DIR=${JSON.stringify(dir)}`,
      'CLAUDE_CMD=""',
      'EPAM_CLI="epam"',
      `LOG_DIR=${JSON.stringify(dir)}`,
      'run_remediation() {',
      `  local _failing_logs=(${JSON.stringify(sastLog)})`,
      '  local _log_labels=("sast-sentinel")',
      '  local phase_id="scaffold"',
      `  local sast_log=${JSON.stringify(sastLog)}`,
      '  local spec_log=""',
      `  local _profiles_file=${JSON.stringify(profilesPath)}`,
      block,
      '}',
      'run_remediation',
      'echo "FINAL_EXIT=$?"',
    ].join('\n');

    let result: { exitCode: number; stdout: string };
    try {
      const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      const m = stdout.match(/FINAL_EXIT=(\d+)/);
      result = { exitCode: m ? parseInt(m[1], 10) : -1, stdout };
    } catch (e: any) {
      const stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      result = { exitCode: e.status ?? -1, stdout };
    }
    let promptsReceived = '';
    try { promptsReceived = readFileSync(promptDumpPath, 'utf8'); } catch { /* no calls made */ }
    rmSync(dir, { recursive: true, force: true });
    return { ...result, promptsReceived };
  }

  it('the prompt sent to profile-augmentor contains the story\'s REAL agentRole (backend-engineer), not a hardcoded typescript-engineer guess', () => {
    const { promptsReceived } = run('backend-engineer', 0, true);
    const augmentorCall = promptsReceived.split('=== CALL ===').find((c) => c.includes('Check if the pattern is novel'));
    expect(augmentorCall).toBeDefined();
    expect(augmentorCall).toMatch(/That story's agentRole.*backend-engineer/);
    expect(augmentorCall).not.toMatch(/typescript-engineer/);
  });

  it('REPRODUCES the exact live defect and proves the fix: acs_added=0 but profile_updated=true now returns exit 2 (retry), not exit 1 (hard stop)', () => {
    const { exitCode, stdout } = run('typescript-engineer', 0, true);
    expect(exitCode).toBe(2);
    expect(stdout).toMatch(/remediation applied, retry required/);
    expect(stdout).not.toMatch(/fix findings and re-run/);
  });

  it('when NEITHER an AC nor a profile update happens, still hard-stops (exit 1) — no regression', () => {
    const { exitCode, stdout } = run('typescript-engineer', 0, false);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/fix findings and re-run/);
  });

  it('an AC addition alone (no profile update) still retries (exit 2) — pre-existing behavior preserved', () => {
    const { exitCode } = run('typescript-engineer', 2, false);
    expect(exitCode).toBe(2);
  });
});
