/**
 * profile-augmentor (Step 4.2, agent 3/3) must verify its claimed
 * "profile_updated": true against the ACTUAL disk state of profiles.json,
 * not trust the agent's own text response.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run, while
 * investigating a broader "version management is weak/fragile" pattern the
 * user raised): the agent has real Bash/WriteFile tool access
 * (AI_GATE_ALLOW_TOOLS=1) and is instructed to "write the updated
 * profiles.json back, then emit the JSON summary." The calling code only
 * checked whether the response TEXT contained `"profile_updated": true` —
 * if the agent claims this without ever actually calling a write tool (the
 * exact same class of defect already found and fixed for story-ac-
 * remediator earlier the same day: "the PRD was never actually updated
 * despite the agent claiming it was"), _profile_remediation_applied gets
 * set to 1 for a change that never happened, and the phase retries believing
 * a fix landed when nothing on disk changed at all.
 *
 * Fix: after the tool call, compare profiles.json's actual content before vs
 * after. If the agent claims profile_updated:true but the file is
 * byte-identical, log it as a no-op and skip to the next gate/finding
 * instead of proceeding to the reviewer gate and setting the applied flag.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('profile-augmentor disk-state verification — wiring (static)', () => {
  it('compares profiles.json before/after and detects a no-op claim', () => {
    const idx = orchSrc.indexOf('grep -q \'"profile_updated"[[:space:]]*:[[:space:]]*true\'');
    const block = orchSrc.slice(idx, idx + 1400);
    // L3 retry fix (2026-07-19): disk check is now inside a 2-attempt retry loop;
    // the affirmative form checks _profiles_after != _profiles_before (sets disk_changed=1),
    // and the guard outside the loop uses _pfa3_disk_changed = 0 to trigger continue.
    expect(block).toMatch(/_pfa3_disk_changed=1/);
    expect(block).toMatch(/unchanged on disk.*treating as no-op, not applied/);
    expect(block).toMatch(/continue/);
  });

  it('the no-op branch runs BEFORE the reviewer gate and the applied flag is only set in the real-change branch', () => {
    const idx = orchSrc.indexOf('grep -q \'"profile_updated"[[:space:]]*:[[:space:]]*true\'');
    const noOpIdx = orchSrc.indexOf('treating as no-op, not applied', idx);
    const reviewerGateIdx = orchSrc.indexOf('# Reviewer gate — validate the change before accepting it', idx);
    const appliedFlagIdx = orchSrc.indexOf('_profile_remediation_applied=1', idx);
    expect(noOpIdx).toBeGreaterThan(idx);
    expect(reviewerGateIdx).toBeGreaterThan(noOpIdx);
    expect(appliedFlagIdx).toBeGreaterThan(reviewerGateIdx);
  });
});

describe('profile-augmentor disk-state verification — REAL execution', () => {
  // Extract JUST the profile-augmentor sub-block (agent 3/3), not the whole
  // per-gate loop — avoids having to simulate gate-finding-analyst and
  // story-ac-remediator (git repo, PRD lookups, etc.) just to reach it.
  function extractProfileAugmentorBlock(): string {
    const start = orchSrc.indexOf('# ── Agent 3: profile-augmentor ─');
    const end = orchSrc.indexOf('\n            done  # end per-gate loop');
    if (start === -1 || end === -1) throw new Error('profile-augmentor block markers not found');
    return orchSrc.slice(start, end);
  }

  function run(opts: {
    initialProfiles: Record<string, string>;
    agentClaimsUpdate: boolean;
    agentActuallyWrites: boolean; // simulates whether the stubbed AI_RUNNER_CMD really writes the file
  }): { finalProfiles: Record<string, string>; log: string; appliedFlagSet: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'profile-augmentor-disk-'));
    try {
      const profilesPath = join(dir, 'profiles.json');
      writeFileSync(profilesPath, JSON.stringify(opts.initialProfiles));

      const writerScriptPath = join(dir, 'write_new_rule.py');
      writeFileSync(
        writerScriptPath,
        [
          'import json',
          `path = ${JSON.stringify(profilesPath)}`,
          "with open(path) as f:",
          "    p = json.load(f)",
          "p['typescript-engineer'] = p.get('typescript-engineer', '') + ' NEW RULE ADDED'",
          "with open(path, 'w') as f:",
          "    json.dump(p, f)",
        ].join('\n'),
      );

      const stubPath = join(dir, 'ai-runner-stub.sh');
      const stubLines = ['#!/usr/bin/env bash', 'prompt=$(cat)']; // consume stdin prompt
      stubLines.push('if echo "$prompt" | grep -q "Check if the pattern is novel"; then');
      if (opts.agentActuallyWrites) {
        stubLines.push(`  python3 ${JSON.stringify(writerScriptPath)}`);
      }
      stubLines.push(`  echo '{"profile":"typescript-engineer","profile_updated":${opts.agentClaimsUpdate ? 'true' : 'false'}}'`);
      stubLines.push('else');
      stubLines.push('  echo \'{"verdict":"pass"}\'');
      stubLines.push('fi');
      writeFileSync(stubPath, stubLines.join('\n'));
      execFileSync('chmod', ['+x', stubPath]);

      const block = extractProfileAugmentorBlock();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          'set -uo pipefail',
          'info() { :; }',
          'warning() { echo "WARN: $*"; }',
          'success() { echo "SUCCESS: $*"; }',
          `AI_RUNNER_CMD=${JSON.stringify(stubPath)}`,
          `_profiles_file=${JSON.stringify(profilesPath)}`,
          `_rem_log=${JSON.stringify(join(dir, 'rem.log'))}`,
          '_story_id="SKY-999"',
          '_story_agent_role="typescript-engineer"',
          '_finding_json="{}"',
          '_glabel="sast-sentinel"',
          'CLAUDE_CMD=""',
          'EPAM_CLI="epam"',
          '_remediation_applied=0',
          '_profile_remediation_applied=0',
          // `continue` inside the extracted block requires an enclosing loop
          // (it does in the real script too — the per-gate `for` loop) —
          // wrap in a single-iteration loop so it's valid here as well.
          'run_profile_augmentor() {',
          '  for _i in 1; do',
          block,
          '  done',
          '}',
          'run_profile_augmentor',
          'echo "APPLIED_FLAG=$_profile_remediation_applied"',
        ].join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const finalProfiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
      const appliedFlagSet = /APPLIED_FLAG=1/.test(stdout);
      return { finalProfiles, log: stdout, appliedFlagSet };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: agent claims profile_updated:true but never actually writes — treated as no-op, applied flag stays 0', () => {
    const { log, appliedFlagSet } = run({
      initialProfiles: { 'typescript-engineer': 'original text' },
      agentClaimsUpdate: true,
      agentActuallyWrites: false, // the exact live defect: claims success, writes nothing
    });
    expect(log).toMatch(/unchanged on disk.*treating as no-op/);
    expect(appliedFlagSet).toBe(false);
  });

  it('when the agent genuinely writes AND claims profile_updated:true, the applied flag is set (no regression to the real-change path)', () => {
    const { appliedFlagSet, finalProfiles } = run({
      initialProfiles: { 'typescript-engineer': 'original text' },
      agentClaimsUpdate: true,
      agentActuallyWrites: true,
    });
    expect(finalProfiles['typescript-engineer']).toContain('NEW RULE ADDED');
    expect(appliedFlagSet).toBe(true);
  });

  it('when the agent claims profile_updated:false (pattern already covered), the applied flag stays 0 regardless of disk state', () => {
    const { appliedFlagSet } = run({
      initialProfiles: { 'typescript-engineer': 'original text' },
      agentClaimsUpdate: false,
      agentActuallyWrites: false,
    });
    expect(appliedFlagSet).toBe(false);
  });
});
