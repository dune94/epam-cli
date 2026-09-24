/**
 * AN ESCALATION REACHES AN OWNER WHOSE LADDER IS ALREADY SPENT.
 *
 * regintel one-story run, 2026-09-24 (v2.0.65): REGI-009a -> REGI-005-B -> REGI-005-A. REGI-005-B,
 * working in its own worktree, diagnosed the codeline's real defect in regintel/classifier.py:
 *   "the dedup pass feeds plain dicts from store.list_events to dedup.find_duplicate, whose
 *    _get_attr uses getattr and returns None for dict fields, so no duplicate is ever detected"
 * and escalated to the file's owner. The engine refused:
 *   "REGI-005-A's ladder is exhausted (retry_count 4 > 2) — no further scoped fix is possible"
 * That count was spent in EARLIER runs and carried in by the resume. A new, specific diagnosis was
 * thrown away by an old budget, so the one bug failing the codeline could never be fixed.
 *
 * Two halves, both needed: resolve_escalation refused, AND implement_story's attempt loop
 * (`while retry_count <= MAX_RETRIES`) would never have entered for an owner at 4 > 2. The
 * escalation brings its own bounded budget (EPAM_ESCALATION_ATTEMPT_BUDGET); a spent owner runs it
 * on its TOP rung — the strongest model its ladder declares.
 *
 * THE SECOND RUN, NOT THE FIRST: the owner's retry state is the file the last run left on disk
 * ("4" in story-retry-state/REGI-005-A.count), read by the REAL story-retry-state.sh. The
 * previous escalation tests stubbed read_story_retry_count to 0, so this case never executed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const LADDER = join(LIB, 'model-ladder.sh');
const HEALING = join(LIB, 'failure-healing.sh');
const RETRY = join(LIB, 'story-retry-state.sh');
const ATTEMPT = join(LIB, 'story-attempt.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Drives the REAL resolve_escalation over a real repo, with the owner's retry state ON DISK. */
function escalate(ownerCount: number | null) {
  const dir = mkdtempSync(join(tmpdir(), 'esc-spent-')); dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam', 'escalations'), { recursive: true });
  mkdirSync(join(repo, 'regintel'), { recursive: true });
  writeFileSync(join(repo, 'regintel', 'classifier.py'), 'def dedup(events):\n    return None\n');
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'baseline');

  const logs = join(dir, 'logs');
  mkdirSync(join(logs, 'story-retry-state'), { recursive: true });
  // Exactly what the 2026-09-24 run carried in: a bare count in <story>.count.
  if (ownerCount !== null) writeFileSync(join(logs, 'story-retry-state', 'REGI-005-A.count'), `${ownerCount}\n`);

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: ['REGI-005-A', 'REGI-005-B'] },
    stories: [
      { id: 'REGI-005-A', status: 'completed', technicalNotes: { files: ['regintel/classifier.py'] } },
      { id: 'REGI-005-B', status: 'pending', technicalNotes: { files: ['tests/test_escalation.py'] } },
    ],
  }));
  writeFileSync(join(repo, '.epam', 'escalations', 'REGI-005-B.json'), JSON.stringify({
    fromStoryId: 'REGI-005-B', targetFile: 'regintel/classifier.py',
    diagnosis: 'the dedup pass feeds plain dicts to find_duplicate, whose getattr returns None for dict fields',
    requiredFix: 'read fields from a dict by key as well as from an object by attribute',
  }));

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export PRD_FILE=${JSON.stringify(prd)}`,
    `export LOG_DIR=${JSON.stringify(logs)}`,
    'export MAX_RETRIES=2',
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    'render_or_keep() { echo ""; }',
    `. ${JSON.stringify(RETRY)}`,                       // THE REAL retry state — nothing stubbed to 0
    // THE AGENT is the only stand-in: it reports what the engine handed it.
    'implement_story() { echo "AGENT-RAN story=$1 budget=${EPAM_ESCALATION_ATTEMPT_BUDGET:-} start=$(escalation_start_retry_count "$(read_story_retry_count "$LOG_DIR" "$1")" "$MAX_RETRIES")"; return 1; }',
    shellFunction(HEALING, '_attempt_start_snapshot'),
    shellFunction(HEALING, '_restore_tree_snapshot'),
    shellFunction(LADDER, '_escalation_branch'),
    shellFunction(LADDER, '_escalation_worktree'),
    shellFunction(LADDER, '_escalation_adopt_work'),
    shellFunction(LADDER, 'resolve_escalation'),
    'resolve_escalation REGI-005-B; echo "RC=$?"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  return { out: (r.stdout || '') + (r.stderr || ''), logs };
}

describe('an escalation reaches an owner whose ladder is already spent', () => {
  it('REPRODUCES 2026-09-24: an owner at retry_count 4 of 2 still gets the escalated fix', () => {
    const { out } = escalate(4);
    expect(out, 'the engine threw away the diagnosis of the bug failing the codeline').not.toMatch(/no further scoped fix is possible/);
    expect(out).toMatch(/AGENT-RAN story=REGI-005-A/);
  });

  it('it runs with the escalation\'s own bounded budget, on the owner\'s TOP rung', () => {
    const { out } = escalate(4);
    const m = /AGENT-RAN story=REGI-005-A budget=(\d+) start=(\d+)/.exec(out);
    expect(m, out).toBeTruthy();
    expect(Number(m![1]), 'unbounded: an escalation must have a budget').toBeGreaterThan(0);
    expect(Number(m![2]), 'the attempt loop runs while retry_count <= MAX_RETRIES — past it, nothing runs').toBe(2);
  });

  it('an owner with rungs left is unchanged: it resumes where its ladder stands', () => {
    const { out } = escalate(1);
    expect(out).toMatch(/AGENT-RAN story=REGI-005-A budget=\d+ start=1/);
  });

  it('an owner with no retry state on disk starts at the bottom', () => {
    const { out } = escalate(null);
    expect(out).toMatch(/AGENT-RAN story=REGI-005-A budget=\d+ start=0/);
  });

  it('the log says the owner runs on its top rung — not that nothing could be done', () => {
    const { out } = escalate(4);
    expect(out).toMatch(/REGI-005-A.*top rung/i);
  });
});

describe('the start rung the attempt loop actually uses', () => {
  const start = (count: string, max: string, budget: string) => spawnSync('bash', ['-c',
    `. ${JSON.stringify(RETRY)}; EPAM_ESCALATION_ATTEMPT_BUDGET=${budget} escalation_start_retry_count ${count} ${max}`], { encoding: 'utf8' }).stdout.trim();

  it('under an escalation budget, a count past the ladder starts on the top rung', () => {
    expect(start('4', '2', '1')).toBe('2');
    expect(start('9', '6', '2')).toBe('6');
  });
  it('under an escalation budget, a count within the ladder is untouched', () => {
    expect(start('1', '2', '1')).toBe('1');
    expect(start('0', '2', '1')).toBe('0');
  });
  it('WITHOUT a budget nothing changes — an ordinary story past its ladder stays past it', () => {
    expect(start('4', '2', '""')).toBe('4');
  });

  it('implement_story seeds its attempt loop through it — the loop is where the refusal really lived', () => {
    const src = readFileSync(ATTEMPT, 'utf8');
    // The line after the declaration IS the seed, whatever it says — so this runs the old code too.
    const decl = src.indexOf('\n    local retry_count\n');
    expect(decl, 'the declaration moved — find it before trusting this').toBeGreaterThan(0);
    const seed = decl + '\n    local retry_count\n'.length;
    const block = src.slice(seed, src.indexOf('\n', seed));
    expect(block, 'the line after the declaration is not the seed').toMatch(/^\s*retry_count="\$\(/);
    // Run the two seeding lines themselves, over the on-disk count, with the real functions.
    const d = mkdtempSync(join(tmpdir(), 'seed-')); dirs.push(d);
    mkdirSync(join(d, 'story-retry-state'), { recursive: true });
    writeFileSync(join(d, 'story-retry-state', 'REGI-005-A.count'), '4\n');
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(RETRY)}; LOG_DIR=${JSON.stringify(d)}; story_id=REGI-005-A; MAX_RETRIES=2; EPAM_ESCALATION_ATTEMPT_BUDGET=1; log(){ :; }\n${block}\necho "retry_count=$retry_count"`], { encoding: 'utf8' });
    expect(r.stdout.trim(), r.stderr).toBe('retry_count=2');
  });
});
