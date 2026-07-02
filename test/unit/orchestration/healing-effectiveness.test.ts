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

  it('reads agentProfile field (not agentRole) to match the fail-analyst logic', () => {
    const funcStart = claudeSrc.indexOf('get_relevant_kb_entries()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/agentProfile/);
  });
});

// ── 3. check_healing_effectiveness structural contract ────────────────────────
describe('claude.sh — check_healing_effectiveness structural contract', () => {
  it('check_healing_effectiveness function is defined', () => {
    expect(claudeSrc).toMatch(/check_healing_effectiveness\s*\(\)/);
  });

  it('reads healing-events.jsonl to count consecutive same-diagnosis events', () => {
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/healing-events\.jsonl/);
  });

  it('uses python3 to count consecutive same-diagnosis events (shell arithmetic insufficient)', () => {
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/python3/);
  });

  it('triggers at threshold ≥ 2 consecutive same-diagnosis repeats', () => {
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/-ge\s+2/);
  });

  it('sets HEALING_BROKEN=1 when threshold exceeded', () => {
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toContain('HEALING_BROKEN=1');
    expect(body).toContain('export HEALING_BROKEN');
  });

  it('writes HEALING_BROKEN sentinel record to healing-events.jsonl', () => {
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toContain('HEALING_BROKEN');
    expect(body).toMatch(/>> "\$heal_log"/);
  });

  it('emits CRITICAL log message when healing broken', () => {
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
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
    const funcStart = claudeSrc.indexOf('check_healing_effectiveness()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart + 50);
    const body      = claudeSrc.slice(funcStart, funcEnd);
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
    const start = claudeSrc.indexOf('check_healing_effectiveness()');
    if (start === -1) throw new Error('check_healing_effectiveness not found in claude.sh');
    const rest  = claudeSrc.slice(start);
    const end   = rest.indexOf('\n}') + 2;
    return rest.slice(0, end);
  }

  function buildScript(healLog: string, events: Array<{ story_id: string; diagnosis: string }>, storyId: string, diagnosis: string): string {
    const eventsJsonl = events
      .map(e => JSON.stringify({ ts: '2026-06-30T00:00:00Z', story_id: e.story_id, retry: 1, target: 'skill', diagnosis: e.diagnosis, patches_applied: 0, profile_updated: false }))
      .join('\n');

    const funcDef = extractCheckFn();
    return `#!/bin/bash
${funcDef}
error() { echo "ERROR: $*" >&2; }
OUTPUT_DIR="${tmpDir}"

# Write pre-existing healing events
cat > "${healLog}" << 'EVEOF'
${eventsJsonl}
EVEOF

# Call the function
HEALING_BROKEN=""
check_healing_effectiveness "${storyId}" "${diagnosis}"
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
OUTPUT_DIR="${tmpDir}"
HEALING_BROKEN=""
check_healing_effectiveness "MOCK-001" "some diagnosis"
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
