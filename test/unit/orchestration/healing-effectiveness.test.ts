/**
 * Healing Effectiveness — TDD tests for:
 *   1. target=kb  → writes compact entry to KB-{agentProfile}.md (agent-specific, truncated)
 *   2. check_healing_effectiveness → detects same-diagnosis repeat ≥2 times
 *
 * Principle: we test the FRAMEWORK, not the travel app.
 * - All data is mock/generated — no reads from live KB.md or real PRD
 * - Bash integration tests write scripts to temp files (avoids JSON.stringify escaping)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// check_healing_effectiveness() now embeds a Python heredoc containing a
// multi-line STOPWORDS set literal whose closing `}` sits at column 0 — a naive
// `indexOf('\n}', ...)` search (used throughout this file for the other,
// simpler functions) stops at that line and truncates the body. Scan
// line-by-line tracking heredoc state instead, and only treat a column-0 `}`
// as the function's end when NOT currently inside a heredoc.
function extractHealingEffectivenessBody(): string {
  const name = 'check_healing_effectiveness';
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  let inHeredoc = false;
  let heredocDelim = '';
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);
    if (!inHeredoc) {
      const m = line.match(/<<-?\s*'?(\w+)'?/);
      if (m) {
        inHeredoc = true;
        heredocDelim = m[1];
        continue;
      }
      if (line === '}') return body.join('\n');
    } else if (line.trim() === heredocDelim) {
      inHeredoc = false;
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

// ── 1. target=kb structural contract ─────────────────────────────────────────
describe('claude.sh — target=kb structural contract', () => {
  it('kb case exists in run_failure_analyst', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    expect(body).toMatch(/\bkb\)/);
  });

  it('kb case writes to KB-${story_role}.md (agent-specific, not monolithic KB.md)', () => {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart);
    const kbBody      = claudeSrc.slice(kbCaseStart, kbCaseEnd);
    expect(kbBody).toMatch(/KB-\$\{story_role\}/);
    expect(kbBody).not.toMatch(/\/KB\.md/);
  });

  it('kb entry is truncated at 200 chars to bound context injection size', () => {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart);
    const kbBody      = claudeSrc.slice(kbCaseStart, kbCaseEnd);
    expect(kbBody).toMatch(/\$\{skill_note:0:200\}/);
  });

  it('kb entry format is compact — single bullet line, not a verbose markdown section', () => {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart);
    const kbBody      = claudeSrc.slice(kbCaseStart, kbCaseEnd);
    // Compact format: "- [timestamp] note" on one line
    expect(kbBody).toContain("printf '\\n- [%s] %s\\n'");
  });

  it('kb case appends with >> (does not truncate the KB file)', () => {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart);
    const kbBody      = claudeSrc.slice(kbCaseStart, kbCaseEnd);
    expect(kbBody).toMatch(/>>/);
  });

  it('sets _profile_updated=true when KB entry is written', () => {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart);
    const kbBody      = claudeSrc.slice(kbCaseStart, kbCaseEnd);
    expect(kbBody).toContain('_profile_updated="true"');
  });

  it('logs [FailureAnalyst] message with KB filename', () => {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart);
    const kbBody      = claudeSrc.slice(kbCaseStart, kbCaseEnd);
    expect(kbBody).toMatch(/FailureAnalyst.*KB-/);
  });
});

// ── 2. get_relevant_kb_entries structural contract ────────────────────────────
describe('claude.sh — get_relevant_kb_entries uses agent-specific KB + bounded output', () => {
  it('get_relevant_kb_entries function exists', () => {
    expect(claudeSrc).toMatch(/get_relevant_kb_entries\s*\(\)/);
  });

  it('reads from KB-{agentProfile}.md (not KB.md)', () => {
    const funcStart = claudeSrc.indexOf('get_relevant_kb_entries()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/KB-\$\{agent_profile\}/);
  });

  it('also reads KB-shared.md for cross-cutting rules', () => {
    const funcStart = claudeSrc.indexOf('get_relevant_kb_entries()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/KB-shared\.md/);
  });

  it('limits output to last N entries via tail (prevents context ballooning)', () => {
    const funcStart = claudeSrc.indexOf('get_relevant_kb_entries()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/tail.*-n\s+\d+/);
  });

  it('reads agentRole field (not agentProfile) — canonical PRD stories have agentRole only', () => {
    const funcStart = claudeSrc.indexOf('get_relevant_kb_entries()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/agentRole/);
    expect(body).not.toMatch(/agentProfile/);
  });
});

// ── 3. check_healing_effectiveness structural contract ────────────────────────
describe('claude.sh — check_healing_effectiveness structural contract', () => {
  it('check_healing_effectiveness function is defined', () => {
    expect(claudeSrc).toMatch(/check_healing_effectiveness\s*\(\)/);
  });

  it('reads healing-events.jsonl to count consecutive same-diagnosis events', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/healing-events\.jsonl/);
  });

  it('uses python3 to count consecutive same-diagnosis events (shell arithmetic insufficient)', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/python3/);
  });

  it('triggers at threshold ≥ 2 consecutive same-diagnosis repeats', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/-ge\s+2/);
  });

  it('sets HEALING_BROKEN=1 when threshold exceeded', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toContain('HEALING_BROKEN=1');
    expect(body).toContain('export HEALING_BROKEN');
  });

  it('writes HEALING_BROKEN sentinel record to healing-events.jsonl', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toContain('HEALING_BROKEN');
    expect(body).toMatch(/>> "\$heal_log"/);
  });

  it('emits CRITICAL log message when healing broken', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/CRITICAL|HealingBroken/);
  });

  it('is called inside run_failure_analyst (after recording the event)', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    expect(body).toMatch(/check_healing_effectiveness/);
  });

  it('called AFTER run_healing_recorder (needs the just-written event to count)', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    const recorderIdx  = body.indexOf('run_healing_recorder');
    const effectiveIdx = body.indexOf('check_healing_effectiveness');
    expect(recorderIdx).toBeGreaterThan(-1);
    expect(effectiveIdx).toBeGreaterThan(recorderIdx);
  });

  it('returns early (no-op) when healing-events.jsonl does not exist yet', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/\[ -f "\$heal_log" \] \|\| return 0/);
  });
});

// ── 4. Integration — target=kb bash execution ─────────────────────────────────
describe('target=kb — bash integration with mock data', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/kb-heal-test-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function extractKbCase(): string {
    const kbCaseStart = claudeSrc.indexOf('\n                kb)');
    const kbCaseEnd   = claudeSrc.indexOf('\n                    ;;', kbCaseStart) + 3;
    return claudeSrc.slice(kbCaseStart, kbCaseEnd);
  }

  it('writes a bullet entry to KB-{agentProfile}.md', () => {
    const kbDir      = join(tmpDir, 'agents');
    const kbFile     = join(kbDir, 'KB-typescript-engineer.md');
    const scriptPath = join(tmpDir, 'run.sh');

    writeFileSync(scriptPath, `#!/bin/bash
mkdir -p "${kbDir}"
story_role="typescript-engineer"
skill_note="Never use require() in ES module files — use import instead"
_profile_updated="false"
kb_dir="${kbDir}"
kb_file="${kbDir}/KB-\${story_role}.md"
kb_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
short_note="\${skill_note:0:200}"
printf '\\n- [%s] %s\\n' "$kb_ts" "$short_note" >> "$kb_file" 2>/dev/null || true
_profile_updated="true"
`);
    execSync(`bash "${scriptPath}"`);
    expect(existsSync(kbFile)).toBe(true);
    const content = readFileSync(kbFile, 'utf8');
    expect(content).toMatch(/- \[\d{4}-\d{2}-\d{2}T/);
    expect(content).toContain('Never use require()');
  });

  it('truncates skill_note to 200 chars', () => {
    const kbDir      = join(tmpDir, 'agents');
    const scriptPath = join(tmpDir, 'run.sh');
    const longNote   = 'A'.repeat(300);

    writeFileSync(scriptPath, `#!/bin/bash
mkdir -p "${kbDir}"
story_role="typescript-engineer"
skill_note="${longNote}"
kb_file="${kbDir}/KB-\${story_role}.md"
kb_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
short_note="\${skill_note:0:200}"
printf '\\n- [%s] %s\\n' "$kb_ts" "$short_note" >> "$kb_file" 2>/dev/null || true
`);
    execSync(`bash "${scriptPath}"`);
    const content = readFileSync(join(kbDir, 'KB-typescript-engineer.md'), 'utf8').trim();
    const entry   = content.split('\n').find(l => l.startsWith('- ['))!;
    // "- [2026-...TXX:XX:XXZ] " prefix + 200 chars of A = < 230 chars total
    const notepart = entry.replace(/^- \[.*?\] /, '');
    expect(notepart.length).toBeLessThanOrEqual(200);
    expect(notepart.length).toBe(200);
  });

  it('appends multiple entries — does not truncate the KB file', () => {
    const kbDir      = join(tmpDir, 'agents');
    const scriptPath = join(tmpDir, 'run.sh');

    writeFileSync(scriptPath, `#!/bin/bash
mkdir -p "${kbDir}"
story_role="typescript-engineer"
kb_file="${kbDir}/KB-\${story_role}.md"
kb_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
short_note="\${skill_note:0:200}"
printf '\\n- [%s] %s\\n' "$kb_ts" "Rule one" >> "$kb_file" 2>/dev/null || true
printf '\\n- [%s] %s\\n' "$kb_ts" "Rule two" >> "$kb_file" 2>/dev/null || true
printf '\\n- [%s] %s\\n' "$kb_ts" "Rule three" >> "$kb_file" 2>/dev/null || true
`);
    execSync(`bash "${scriptPath}"`);
    const content = readFileSync(join(kbDir, 'KB-typescript-engineer.md'), 'utf8');
    expect(content).toContain('Rule one');
    expect(content).toContain('Rule two');
    expect(content).toContain('Rule three');
  });

  it('frontend-engineer story writes to KB-frontend-engineer.md (not typescript)', () => {
    const kbDir      = join(tmpDir, 'agents');
    const scriptPath = join(tmpDir, 'run.sh');

    writeFileSync(scriptPath, `#!/bin/bash
mkdir -p "${kbDir}"
story_role="frontend-engineer"
skill_note="Always wrap async calls in try/catch inside useEffect"
kb_file="${kbDir}/KB-\${story_role}.md"
kb_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
short_note="\${skill_note:0:200}"
printf '\\n- [%s] %s\\n' "$kb_ts" "$short_note" >> "$kb_file" 2>/dev/null || true
`);
    execSync(`bash "${scriptPath}"`);
    expect(existsSync(join(kbDir, 'KB-frontend-engineer.md'))).toBe(true);
    expect(existsSync(join(kbDir, 'KB-typescript-engineer.md'))).toBe(false);
    const content = readFileSync(join(kbDir, 'KB-frontend-engineer.md'), 'utf8');
    expect(content).toContain('useEffect');
  });
});

// ── 5. Integration — check_healing_effectiveness bash execution ───────────────
describe('check_healing_effectiveness — bash integration with mock data', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/heal-eff-test-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function extractCheckFn(): string {
    return extractHealingEffectivenessBody();
  }

  function buildScript(healLog: string, events: Array<{ story_id: string; diagnosis: string }>, storyId: string, diagnosis: string): string {
    const eventsJsonl = events
      .map(e => JSON.stringify({ ts: '2026-06-30T00:00:00Z', story_id: e.story_id, retry: 1, target: 'skill', diagnosis: e.diagnosis, patches_applied: 0, profile_updated: false }))
      .join('\n');

    const funcDef = extractCheckFn();
    return `#!/bin/bash
${funcDef}
error() { echo "ERROR: $*" >&2; }
LOG_DIR="${tmpDir}"

# Write pre-existing healing events
cat > "${healLog}" << 'EVEOF'
${eventsJsonl}
EVEOF

# Call the function
HEALING_BROKEN=""
check_healing_effectiveness "${storyId}" "${diagnosis}" "2"
echo "HEALING_BROKEN_VALUE=\${HEALING_BROKEN:-}"
`;
  }

  it('sets HEALING_BROKEN=1 when same diagnosis appears 2+ consecutive times', () => {
    const healLog   = join(tmpDir, 'healing-events.jsonl');
    const diagnosis = 'missing null check causes TypeError';
    const script    = buildScript(healLog, [
      { story_id: 'MOCK-001', diagnosis },
      { story_id: 'MOCK-001', diagnosis },
    ], 'MOCK-001', diagnosis);

    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, script);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).toContain('HEALING_BROKEN_VALUE=1');
  });

  it('writes HEALING_BROKEN sentinel record to healing-events.jsonl', () => {
    const healLog   = join(tmpDir, 'healing-events.jsonl');
    const diagnosis = 'import path resolution fails in vitest';
    const script    = buildScript(healLog, [
      { story_id: 'MOCK-001', diagnosis },
      { story_id: 'MOCK-001', diagnosis },
    ], 'MOCK-001', diagnosis);

    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, script);
    execSync(`bash "${scriptPath}"`);

    const lines   = readFileSync(healLog, 'utf8').trim().split('\n');
    const sentinel = lines.find(l => {
      try { return JSON.parse(l)?.event === 'HEALING_BROKEN'; } catch { return false; }
    });
    expect(sentinel).toBeTruthy();
    const parsed = JSON.parse(sentinel!);
    expect(parsed.story_id).toBe('MOCK-001');
    expect(parsed.count).toBeGreaterThanOrEqual(2);
  });

  it('does NOT set HEALING_BROKEN when diagnoses differ', () => {
    const healLog    = join(tmpDir, 'healing-events.jsonl');
    const scriptPath = join(tmpDir, 'run.sh');
    const script     = buildScript(healLog, [
      { story_id: 'MOCK-001', diagnosis: 'first failure type' },
      { story_id: 'MOCK-001', diagnosis: 'different failure type' },
    ], 'MOCK-001', 'different failure type');

    writeFileSync(scriptPath, script);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).toContain('HEALING_BROKEN_VALUE=');
    expect(result).not.toContain('HEALING_BROKEN_VALUE=1');
  });

  it('does NOT set HEALING_BROKEN for a single occurrence (needs 2+ consecutive)', () => {
    const healLog    = join(tmpDir, 'healing-events.jsonl');
    const scriptPath = join(tmpDir, 'run.sh');
    const diagnosis  = 'only happened once';
    const script     = buildScript(healLog, [
      { story_id: 'MOCK-001', diagnosis },
    ], 'MOCK-001', diagnosis);

    writeFileSync(scriptPath, script);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).not.toContain('HEALING_BROKEN_VALUE=1');
  });

  it('only counts consecutive events — gap resets the streak', () => {
    const healLog    = join(tmpDir, 'healing-events.jsonl');
    const scriptPath = join(tmpDir, 'run.sh');
    const diagnosis  = 'repeated after gap';
    const script     = buildScript(healLog, [
      { story_id: 'MOCK-001', diagnosis },
      { story_id: 'MOCK-001', diagnosis: 'different in between' },
      { story_id: 'MOCK-001', diagnosis },
    ], 'MOCK-001', diagnosis);

    writeFileSync(scriptPath, script);
    const result = execSync(`bash "${scriptPath}"`).toString();
    // After the gap the streak is only 1 — should NOT trigger
    expect(result).not.toContain('HEALING_BROKEN_VALUE=1');
  });

  it('ignores events from other stories when counting streaks', () => {
    const healLog    = join(tmpDir, 'healing-events.jsonl');
    const scriptPath = join(tmpDir, 'run.sh');
    const diagnosis  = 'shared diagnosis text';
    const script     = buildScript(healLog, [
      { story_id: 'MOCK-002', diagnosis },  // different story
      { story_id: 'MOCK-001', diagnosis },  // only 1 for MOCK-001
    ], 'MOCK-001', diagnosis);

    writeFileSync(scriptPath, script);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).not.toContain('HEALING_BROKEN_VALUE=1');
  });

  it('no-ops gracefully when healing-events.jsonl does not exist', () => {
    const scriptPath = join(tmpDir, 'run.sh');
    const funcDef    = extractCheckFn();
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
error() { echo "ERROR: $*" >&2; }
LOG_DIR="${tmpDir}"
HEALING_BROKEN=""
check_healing_effectiveness "MOCK-001" "some diagnosis" "0"
echo "HEALING_BROKEN_VALUE=\${HEALING_BROKEN:-}"
echo "exit_ok=1"
`);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).toContain('exit_ok=1');
    expect(result).not.toContain('HEALING_BROKEN_VALUE=1');
  });

  it('HEALING_BROKEN triggers at exactly 2 (not only at 3+)', () => {
    const healLog   = join(tmpDir, 'healing-events.jsonl');
    const diagnosis = 'exact two repeats';
    const script    = buildScript(healLog, [
      { story_id: 'MOCK-001', diagnosis },
      { story_id: 'MOCK-001', diagnosis },
    ], 'MOCK-001', diagnosis);

    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, script);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).toContain('HEALING_BROKEN_VALUE=1');
  });
});

// ── 6. Regression: Bug — agentRole vs agentProfile ────────────────────────────
// Both run_failure_analyst and get_relevant_kb_entries must read .agentRole.
// PRD canonical stories have agentRole only; agentProfile does not exist.
// Reading .agentProfile silently fell back to "typescript-engineer" for every story.
describe('regression: agentRole used everywhere (not agentProfile)', () => {
  it('run_failure_analyst reads .agentRole from PRD (not .agentProfile)', () => {
    const funcStart = claudeSrc.indexOf('run_failure_analyst()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 100);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    // The jq query that sets story_role must use agentRole
    expect(body).toMatch(/\.agentRole\s*\/\/\s*["']typescript-engineer["']/);
    expect(body).not.toMatch(/\.agentProfile\s*\/\/\s*["']typescript-engineer["']/);
  });

  it('get_relevant_kb_entries reads .agentRole from PRD (not .agentProfile)', () => {
    const funcStart = claudeSrc.indexOf('get_relevant_kb_entries()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/\.agentRole/);
    expect(body).not.toMatch(/\.agentProfile/);
  });

  it('neither function contains the string "agentProfile" anywhere in its body', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const kbStart      = claudeSrc.indexOf('get_relevant_kb_entries()');
    const kbEnd        = claudeSrc.indexOf('\n}', kbStart + 50);
    const analystBody  = claudeSrc.slice(analystStart, analystEnd);
    const kbBody       = claudeSrc.slice(kbStart, kbEnd);
    expect(analystBody).not.toContain('agentProfile');
    expect(kbBody).not.toContain('agentProfile');
  });
});

// ── 7. Regression: Bug — flat profiles.json skill persistence ─────────────────
// profiles.json is {role: "prompt string"} — NOT {profiles: {role: {addendum: ""}}}
// The old nested-write silently printed an error and left profiles unchanged.
describe('regression: skill persistence handles flat profiles.json structure', () => {
  it('skill case python uses profiles[role] (flat) not profiles["profiles"][role]["addendum"]', () => {
    const skillStart = claudeSrc.indexOf("\n                skill)");
    const skillEnd   = claudeSrc.indexOf('\n                    ;;\n', skillStart);
    const body       = claudeSrc.slice(skillStart, skillEnd);
    // Flat write: profiles[role] = ...
    expect(body).toMatch(/profiles\[role\]\s*=/);
    // Must NOT use the nested nested path that failed
    expect(body).not.toMatch(/profiles\['profiles'\]\[role\]/);
    expect(body).not.toMatch(/profiles\.get\(['"]profiles['"]/);
  });

  it('skill_addendum reading in run_failure_analyst uses flat .[$role] + grep (not .profiles[$role].addendum)', () => {
    const funcStart = claudeSrc.indexOf('run_failure_analyst()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 100);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    // Must NOT use the old nested jq path
    expect(body).not.toMatch(/\.profiles\[\$role\]\.addendum/);
    // Must extract Self-Heal lines from the flat profile string
    expect(body).toMatch(/\[Self-Heal\]/);
    expect(body).toMatch(/grep.*\[Self-Heal\]|grep.*Self-Heal/);
  });

  it('integration: python persists skill note to flat profiles.json format', () => {
    const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
    const { execSync } = require('node:child_process');
    const { join } = require('node:path');
    const tmp = mkdtempSync('/tmp/flat-profile-test-');
    const profilesPath = join(tmp, 'profiles.json');

    // Flat structure — matches real profiles.json
    writeFileSync(profilesPath, JSON.stringify({
      'typescript-engineer': 'You are a TypeScript engineer. Build production-quality code.',
      'frontend-engineer':   'You are a frontend engineer. Build UI components.',
    }, null, 2));

    const scriptPath = join(tmp, 'run.sh');
    writeFileSync(scriptPath, `#!/usr/bin/env bash
python3 - << 'PYEOF'
import json, sys
profiles_path = '${profilesPath}'
role = 'typescript-engineer'
note = '[Self-Heal] Never use require() in ES module files'
with open(profiles_path) as f:
    profiles = json.load(f)
if role in profiles:
    existing = profiles[role]
    sep = '\\n\\n' if existing else ''
    profiles[role] = existing + sep + note
    with open(profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
    print('persisted')
else:
    print('NOT FOUND', file=sys.stderr)
    sys.exit(1)
PYEOF
`);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).toContain('persisted');
    const updated = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(updated['typescript-engineer']).toContain('[Self-Heal]');
    expect(updated['typescript-engineer']).toContain('Never use require()');
    // Other roles must be untouched
    expect(updated['frontend-engineer']).not.toContain('[Self-Heal]');
    require('node:fs').rmSync(tmp, { recursive: true, force: true });
  });
});

// ── 8. Regression: Bug — 20-char exact-prefix match missed real paraphrased repeats ──
// Live-confirmed (run #14, 2026-07-04): SKY-004 attempts 6 and 7 diagnosed the SAME
// bug (wrong/missing public/index.html path), but the analyst phrased them
// completely differently ("Code uses '../public/index.html'..." vs "Agent referenced
// src/public/index.html but didn't create the file...") — zero shared 20-char prefix,
// so the old exact-prefix-match design silently missed the repeat right after
// escalating to the top of the retry ladder, the most expensive point to miss it.
// Fix: token-overlap matching — extract significant words (len>=4, minus stopwords)
// from each diagnosis; treat as the same root cause when the overlap is both at
// least min(3, vocab size) words AND at least 40% of the smaller diagnosis's vocabulary.
describe('regression: HEALING_BROKEN fires on paraphrased repeats (token-overlap match)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/heal-wording-test-');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function extractCheckFn(): string {
    return extractHealingEffectivenessBody();
  }

  it('structural: uses word-token extraction (>=4 chars) with a stopword list, not a fixed-length prefix', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/STOPWORDS/);
    expect(body).toMatch(/\{4,\}/);
    expect(body).not.toMatch(/diag\s*=.*\[:20\]/);
  });

  it('structural: requires both an absolute overlap floor AND a ratio floor (either alone is exploitable)', () => {
    const body = extractHealingEffectivenessBody();
    expect(body).toMatch(/min\(3,\s*len\(ta\),\s*len\(tb\)\)/);
    expect(body).toMatch(/ratio >= 0\.4/);
  });

  it('integration: fires when two diagnoses describe the same root cause with zero shared 20-char prefix (live SKY-004 case)', () => {
    const healLog = join(tmpDir, 'healing-events.jsonl');
    // Real diagnoses from run #14 (2026-07-04) — same public/index.html path bug,
    // completely different phrasing, no shared prefix at all.
    const diag1   = "Code uses '../public/index.html' from src/server.ts, but file lives at src/public/index.html, so readFileSync resolves to a missing path.";
    const diag2   = "Agent referenced src/public/index.html but didn't create the file and used wrong relative path (../public/index.html).";
    const current = diag2;
    expect(diag1.slice(0, 20)).not.toBe(diag2.slice(0, 20));

    const funcDef = extractCheckFn();
    const events  = [
      JSON.stringify({ ts: '2026-07-02T09:51:00Z', story_id: 'MOCK-001', retry: 1, target: 'skill', diagnosis: diag1, patches_applied: 0, profile_updated: false }),
      JSON.stringify({ ts: '2026-07-02T09:53:00Z', story_id: 'MOCK-001', retry: 2, target: 'skill', diagnosis: diag2, patches_applied: 0, profile_updated: false }),
    ].join('\n');

    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
error() { echo "ERROR: \$*" >&2; }
LOG_DIR="${tmpDir}"
cat > "${healLog}" << 'EVEOF'
${events}
EVEOF
HEALING_BROKEN=""
check_healing_effectiveness "MOCK-001" "${current}" "2"
echo "HEALING_BROKEN_VALUE=\${HEALING_BROKEN:-}"
`);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).toContain('HEALING_BROKEN_VALUE=1');
  });

  it('integration: does NOT fire when 20-char prefixes are genuinely different root causes', () => {
    const healLog = join(tmpDir, 'healing-events.jsonl');
    const diag1   = 'missing null check causes TypeError when accessing .length on undefined value';
    const diag2   = 'process.exit mock not reset between tests bleeds into subsequent assertions';
    const current = diag2;

    const funcDef = extractCheckFn();
    const events  = [
      JSON.stringify({ ts: '2026-07-02T09:51:00Z', story_id: 'MOCK-001', retry: 1, target: 'skill', diagnosis: diag1, patches_applied: 0, profile_updated: false }),
      JSON.stringify({ ts: '2026-07-02T09:53:00Z', story_id: 'MOCK-001', retry: 2, target: 'skill', diagnosis: diag2, patches_applied: 0, profile_updated: false }),
    ].join('\n');

    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
error() { echo "ERROR: \$*" >&2; }
LOG_DIR="${tmpDir}"
cat > "${healLog}" << 'EVEOF'
${events}
EVEOF
HEALING_BROKEN=""
check_healing_effectiveness "MOCK-001" "${current}" "2"
echo "HEALING_BROKEN_VALUE=\${HEALING_BROKEN:-}"
`);
    const result = execSync(`bash "${scriptPath}"`).toString();
    expect(result).not.toContain('HEALING_BROKEN_VALUE=1');
  });
});

// ── 9. Regression: Bug — HEALING_BROKEN must abort the retry loop ─────────────
// HEALING_BROKEN was set and exported but the retry loop never checked it.
// Retries continued burning tokens even when healing was confirmed broken.
describe('regression: HEALING_BROKEN check exists in retry loop (implement_story)', () => {
  // Extract implement_story body by finding the block between the function start
  // and the "error Failed to implement" line that marks the end of the retry loop.
  function getImplStoryBody(): string {
    const funcStart  = claudeSrc.indexOf('implement_story()');
    const endMarker  = claudeSrc.indexOf('Failed to implement', funcStart);
    return claudeSrc.slice(funcStart, endMarker);
  }

  it('implement_story checks HEALING_BROKEN and breaks out of retry loop', () => {
    const body = getImplStoryBody();
    expect(body).toMatch(/HEALING_BROKEN:-0.*-eq\s+1|HEALING_BROKEN.*-eq\s+1/);
    expect(body).toMatch(/\bbreak\b/);
  });

  it('HEALING_BROKEN is reset to 0 after aborting (prevents bleed into next story)', () => {
    const body = getImplStoryBody();
    expect(body).toContain('HEALING_BROKEN=0');
  });

  it('abort check appears after run_failure_analyst call in the body', () => {
    const body           = getImplStoryBody();
    const analystIdx     = body.indexOf('run_failure_analyst');
    const brokenCheckIdx = body.indexOf('HEALING_BROKEN:-0');
    expect(analystIdx).toBeGreaterThan(-1);
    expect(brokenCheckIdx).toBeGreaterThan(analystIdx);
  });
});
