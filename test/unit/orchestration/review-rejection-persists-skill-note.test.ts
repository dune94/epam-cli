/**
 * Step 3.6's review-escalation branch hands the review's blocking lessons to the WRITER's role —
 * through the run's guidance ledger, never profiles.json.
 *
 * 2026-08-02 (upexpress AMSD-2041): a story that repeatedly failed review for the identical reason had
 * no mechanism feeding the lesson back to the writer. The fix then wrote it into profiles.json. Since
 * the SI convergence (2026-09-29/30) nothing reads profiles.json into any agent — and writing an
 * engine file that outlives the run breaks the operator's rule of 2026-08-12 ("there can be no
 * lingering anything to skew runs"). One path now (operator, 2026-09-30): the lesson is recorded for
 * the story's ROLE in the run's own guidance ledger (LOG_DIR), and every later story of that role
 * receives it in its prompt — this run only.
 *
 * Real execution of the actual review loop (REVIEW_LOOP_BLOCK), with the REAL ledger functions from
 * lib/knowledge-base.sh; the delivery is asserted on the prompt section build_kb_prompt_section renders.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource, shellFunction } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = engineSource(ORCH_SH) + '\n' + engineSource(join(REPO_ROOT, 'orchestrations/scripts/lib/review-cycle.sh'));

function extractBlock(startMarker: string, endMarker: string): string {
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = orchSrc.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return orchSrc.slice(start, end + endMarker.length);
}

const STORY_RETRY_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const PHASE_ASSESSMENT_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/phase-assessment.sh');
const KB_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/knowledge-base.sh');
const GUARDS_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');

const REVIEW_LOOP_BLOCK = extractBlock(
  'run_review_cycle() {',   // Step 3.6 is run_review_cycle in lib/review-cycle.sh since 2026-09-21
  // END THE BLOCK ON A STABLE ANCHOR, NOT ON AN EXIT CODE.
// This pinned `exit 2`, so the suite failed to LOAD the moment Step 3.6 changed to
// exit 3 (a HALT is not a remediation and must not be retried). Stopping at the message
// instead left the enclosing `if` unclosed, and bash exited 2 on the syntax error.
// The next section header is outside the block and does not move when a code does.
  '    return 0\n}',
);

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runReviewLoop(opts: {
  prdStories: any[];
  reviewIssues?: Array<{ severity: string; description: string }>;
  /** A story whose prompt section is rendered after the loop, to see what the ledger delivers. */
  renderFor?: { id: string; agentRole?: string };
}): { output: string; ledger: Array<{ role?: string; storyId?: string; note: string; target: string }>; profilesBefore: string; profilesAfter: string; rendered: string } {
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

  if (opts.renderFor) {
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.stories.push(opts.renderFor); prd.implementationOrder.core.push(opts.renderFor.id);
    writeFileSync(prdPath, JSON.stringify(prd));
  }
  const profilesBefore = readFileSync(profilesPath, 'utf8');
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
      // THE REAL LEDGER — the functions the retry prompt reads from — and the real anti-pattern check.
      `source ${JSON.stringify(KB_LIB)}`,
      shellFunction(GUARDS_LIB, '_text_violates_anti_pattern'),
      `source ${JSON.stringify(STORY_RETRY_LIB)}`,
      'review_feedback_to_reimplement() { local _f; for _f in "$LOG_DIR"/review-feedback-*.json; do [ -f "$_f" ] || continue; _f=$(basename "$_f" .json); printf "%s\\n" "${_f#review-feedback-}"; done; }',
      // the loop's collaborators, from the lib that owns them (lib/phase-assessment.sh)
      ...['_escalate_review_story', '_review_tree_fingerprint', '_review_approval_is_giveup'].map((n) => shellFunction(PHASE_ASSESSMENT_LIB, n)),
      REVIEW_LOOP_BLOCK,
      'run_review_cycle; _rc_review=$?',
      // What the NEXT story of a role is handed, rendered whatever the review loop returned.
      ...(opts.renderFor ? [`echo "RENDER_START"; build_kb_prompt_section ${JSON.stringify(opts.renderFor.id)} 0; echo "RENDER_END"`] : []),
      'if [ "$_rc_review" -ne 0 ]; then exit "$_rc_review"; fi',
      'echo "REACHED_END"',
    ].join('\n'),
  );

  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const output = (result.stdout || '') + (result.stderr || '');
  let ledger: Array<{ role?: string; storyId?: string; note: string; target: string }> = [];
  try { ledger = readFileSync(join(logDir, 'run-guidance.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { ledger = []; }
  const rendered = (output.split('RENDER_START')[1] || '').split('RENDER_END')[0] || '';
  return { output, ledger, profilesBefore, profilesAfter: readFileSync(profilesPath, 'utf8'), rendered };
}

describe('Step 3.6 review-escalation — the lesson reaches the writer\'s role through the run\'s ledger', () => {
  it('records the blocker lesson for the story\'s agentRole in the run ledger — and never touches profiles.json', () => {
    const r = runReviewLoop({ prdStories: [{ id: 'AMSD-2041', agentRole: 'writer' }] });
    const forRole = r.ledger.filter((e) => e.role === 'writer');
    expect(forRole, r.output.slice(-1500)).toHaveLength(1);
    expect(forRole[0].note).toMatch(/AMSD-2041/);
    expect(forRole[0].note).toMatch(/live_preview never forwarded through getEntry/);
    expect(r.profilesAfter, 'profiles.json was written').toBe(r.profilesBefore);
  });

  it('DELIVERS it: the next story of the same role receives the lesson in its prompt; another role does not', () => {
    const same = runReviewLoop({ prdStories: [{ id: 'AMSD-2041', agentRole: 'writer' }], renderFor: { id: 'AMSD-2050', agentRole: 'writer' } });
    expect(same.rendered.trim().length, 'the prompt section rendered nothing').toBeGreaterThan(0);
    expect(same.rendered).toMatch(/live_preview never forwarded through getEntry/);
    const other = runReviewLoop({ prdStories: [{ id: 'AMSD-2041', agentRole: 'writer' }], renderFor: { id: 'AMSD-2051', agentRole: 'test-engineer' } });
    expect(other.rendered.trim().length).toBeGreaterThan(0);
    expect(other.rendered).not.toMatch(/live_preview never forwarded through getEntry/);
  });

  it('records nothing when the story has no agentRole set', () => {
    const r = runReviewLoop({ prdStories: [{ id: 'AMSD-2041' }] });
    expect(r.ledger.filter((e) => e.role)).toHaveLength(0);
  });

  it('records nothing when there are no blocker-severity issues', () => {
    const r = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041', agentRole: 'writer' }],
      reviewIssues: [{ severity: 'minor', description: 'nit: rename variable' }],
    });
    expect(r.ledger.filter((e) => e.role)).toHaveLength(0);
  });

  it('records one lesson per escalated story, each for its own role', () => {
    const r = runReviewLoop({
      prdStories: [
        { id: 'AMSD-2041', agentRole: 'writer' },
        { id: 'AMSD-2042', agentRole: 'test-engineer' },
      ],
    });
    expect(r.ledger.filter((e) => e.role).map((e) => e.role).sort()).toEqual(['test-engineer', 'writer']);
  });

  it('record_run_guidance_for_role: no LOG_DIR refuses and writes nothing; with one it records the role lesson', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-ledger-')); cleanupDirs.push(dir);
    const call = (env: string) => spawnSync('bash', ['-c', `${env} source ${JSON.stringify(KB_LIB)}; record_run_guidance_for_role writer "a lesson" review-escalation; echo "rc=$?"`], { encoding: 'utf8' });
    const none = call('unset LOG_DIR;');
    expect(none.stdout + none.stderr).not.toMatch(/rc=0/);
    const ok = call(`export LOG_DIR=${JSON.stringify(dir)};`);
    expect(ok.stdout).toMatch(/rc=0/);
    const line = JSON.parse(readFileSync(join(dir, 'run-guidance.jsonl'), 'utf8').trim());
    expect(line).toMatchObject({ role: 'writer', note: 'a lesson', target: 'review-escalation' });
  });
});
