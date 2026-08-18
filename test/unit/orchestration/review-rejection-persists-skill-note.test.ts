/**
 * Step 3.6's review-escalation branch must persist the review's blocker
 * lessons to the WRITER's own profile via _persist_skill_note_simple(), not
 * just to the reviewer's own KB scratchpad.
 *
 * Root cause this closes (found live, 2026-08-02, upexpress AMSD-2041): a
 * story that repeatedly fails review for the identical reason (live_preview
 * never forwarded through public query functions) had no mechanism feeding
 * that lesson back to the writer across runs — only FailureAnalyst's
 * tsc/test-failure diagnoses persisted via claude.sh's heavier
 * run_change_with_reviewer_retry. This proves the new call site: on
 * escalation, the story's agentRole and the review's blocker descriptions
 * are extracted and handed to _persist_skill_note_simple with the shared
 * AGENT_PROFILES_FILE.
 *
 * Real execution of the actual, unmodified bash block, extracted by marker
 * (same block REVIEW_LOOP_BLOCK as review-escalation-clears-on-approval.test.ts).
 * _persist_skill_note_simple itself is stubbed here (it has its own full
 * coverage in skill-note-persist-simple.test.ts) — this file only proves the
 * WIRING: is it called, with what role, with what text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = orchSrc.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return orchSrc.slice(start, end + endMarker.length);
}

const STORY_RETRY_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');

const REVIEW_LOOP_BLOCK = extractBlock(
  '_review_max_retries="${EPAM_MAX_RETRIES:-7}"',
  // END THE BLOCK ON A STABLE ANCHOR, NOT ON AN EXIT CODE.
// This pinned `exit 2`, so the suite failed to LOAD the moment Step 3.6 changed to
// exit 3 (a HALT is not a remediation and must not be retried). Stopping at the message
// instead left the enclosing `if` unclosed, and bash exited 2 on the syntax error.
// The next section header is outside the block and does not move when a code does.
  '# Step 3.7: Pre-review build gate',
);

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runReviewLoop(opts: {
  prdStories: any[];
  reviewIssues?: Array<{ severity: string; description: string }>;
}): { output: string; calls: Array<{ profilesFile: string; role: string; text: string }> } {
  const dir = mkdtempSync(join(tmpdir(), 'review-persist-skill-note-'));
  cleanupDirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const prdPath = join(dir, 'prd.json');
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ writer: 'base prompt' }));
  writeFileSync(
    prdPath,
    JSON.stringify({
      implementationOrder: { core: opts.prdStories.map((s) => s.id) },
      stories: opts.prdStories,
    }),
  );

  const issues = opts.reviewIssues ?? [
    { severity: 'blocker', description: 'live_preview never forwarded through getEntry' },
  ];
  const feedback = JSON.stringify({ verdict: 'changes_requested', summary: 'x', issues });

  const stubPath = join(dir, 'team-lead-review.sh');
  writeFileSync(
    stubPath,
    [
      '#!/usr/bin/env bash',
      ...opts.prdStories.map((s) => `cat > "$LOG_DIR/review-feedback-${s.id}.json" << 'EOF'\n${feedback}\nEOF`),
      'exit 1',
    ].join('\n'),
  );
  chmodSync(stubPath, 0o755);

  const callLogPath = join(dir, 'persist-calls.log');
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `export SCRIPT_DIR=${JSON.stringify(dir)}`,
      `export PRD_FILE=${JSON.stringify(prdPath)}`,
      `export AGENT_PROFILES_FILE=${JSON.stringify(profilesPath)}`,
      `export PHASE=core`,
      `export LOG_DIR=${JSON.stringify(logDir)}`,
      'log() { echo "LOG: $*"; }',
      'warning() { echo "WARN: $*"; }',
      'error() { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      '_emit_agent() { :; }',
      'review_feedback_is_incomplete() { return 1; }',
      '_reset_story_for_reimplementation() { :; }',
      'run_story_with_watchdog() { :; }',
      // Stub under test: record every call instead of touching real profiles.json
      // (that mechanism is fully covered separately in skill-note-persist-simple.test.ts).
      // $3 (the note text) legitimately contains embedded newlines, so records
      // are field/record-separated with \x1f/\x1e rather than tab/newline.
      `_persist_skill_note_simple() { printf '%s\\x1f%s\\x1f%s\\x1e' "$1" "$2" "$3" >> ${JSON.stringify(callLogPath)}; }`,
      `source ${JSON.stringify(STORY_RETRY_LIB)}`,
      REVIEW_LOOP_BLOCK,
      'echo "REACHED_END"',
    ].join('\n'),
  );

  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const output = (result.stdout || '') + (result.stderr || '');
  let calls: Array<{ profilesFile: string; role: string; text: string }> = [];
  try {
    calls = readFileSync(callLogPath, 'utf8')
      .split('\x1e')
      .filter(Boolean)
      .map((record) => {
        const [profilesFile, role, ...rest] = record.split('\x1f');
        return { profilesFile, role, text: rest.join('\x1f') };
      });
  } catch {
    calls = [];
  }
  return { output, calls };
}

describe('Step 3.6 review-escalation — persists a skill note to the writer profile', () => {
  it('calls _persist_skill_note_simple with the AGENT_PROFILES_FILE, the story\'s agentRole, and the blocker text, on escalation', () => {
    const { calls } = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041', agentRole: 'writer' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('writer');
    expect(calls[0].text).toMatch(/AMSD-2041/);
    expect(calls[0].text).toMatch(/live_preview never forwarded through getEntry/);
  });

  it('does NOT call _persist_skill_note_simple when the story has no agentRole set', () => {
    const { calls } = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041' }],
    });
    expect(calls).toHaveLength(0);
  });

  it('does NOT call _persist_skill_note_simple when there are no blocker-severity issues', () => {
    const { calls } = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041', agentRole: 'writer' }],
      reviewIssues: [{ severity: 'minor', description: 'nit: rename variable' }],
    });
    expect(calls).toHaveLength(0);
  });

  it('persists one call per escalated story when multiple stories in the phase escalate', () => {
    const { calls } = runReviewLoop({
      prdStories: [
        { id: 'AMSD-2041', agentRole: 'writer' },
        { id: 'AMSD-2042', agentRole: 'test-engineer' },
      ],
    });
    expect(calls).toHaveLength(2);
    const roles = calls.map((c) => c.role).sort();
    expect(roles).toEqual(['test-engineer', 'writer']);
  });
});
