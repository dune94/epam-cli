/**
 * AN ESCALATION ALREADY TRIED IS NOT TRIED AGAIN — ITS RESULT IS HANDED BACK INSTEAD.
 *
 * Live, one-story run 2026-09-23: eight attempts, ~$5.28, and THREE of those attempts re-entered
 * an escalation that had already failed in the same run —
 *
 *     17:05  [Escalation] Scoped fix for REGI-003a did not converge (retry_count 1)
 *     17:52  [Escalation] REGI-003a ... did not converge (retry_count 2)      ← same story, same file
 *     17:28  [Escalation] REGI-002   ... did not converge
 *     18:01  [Escalation] REGI-005-B ... did not converge
 *
 * Each re-entry costs a full writer attempt — roughly $0.66 here, about $2 of the $5.28 — and
 * tells the escalating story nothing it did not already know. Earlier the same shape ran between
 * REGI-002 and REGI-001a, each correctly diagnosing that the defect lived in the other's file.
 *
 * This is NOT a gate that blocks the escalation. Nothing is refused and nothing is discarded: the
 * scoped fix simply is not RE-RUN for a (story, file) pair that already failed this run, and what
 * happened last time — the diagnosis, the worktree holding the work — is handed to the escalating
 * story's next prompt, which is the one thing that lets it try something different.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const LADDER = join(ROOT, 'orchestrations/scripts/lib/model-ladder.sh');
const HEALING = join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Escalates the same defect twice in one run; records every scoped-fix invocation. */
function escalateTwice(opts: { secondTargetFile?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'esc-repeat-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam', 'escalations'), { recursive: true });
  mkdirSync(join(repo, 'regintel'), { recursive: true });
  writeFileSync(join(repo, 'regintel', 'ingest.py'), 'def parse():\n    return None\n');
  writeFileSync(join(repo, 'regintel', 'dedup.py'), 'def find():\n    return None\n');
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'baseline');

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: ['A-1', 'B-1', 'C-1'] },
    stories: [
      { id: 'A-1', status: 'pending', technicalNotes: { files: ['regintel/classifier.py'] } },
      { id: 'B-1', status: 'pending', technicalNotes: { files: ['regintel/ingest.py'] } },
      { id: 'C-1', status: 'pending', technicalNotes: { files: ['regintel/dedup.py'] } },
    ],
  }));
  const escFile = join(repo, '.epam', 'escalations', 'A-1.json');
  const writeEsc = (target: string) => writeFileSync(escFile, JSON.stringify({
    fromStoryId: 'A-1', targetFile: target,
    diagnosis: 'RU-006 is never deduplicated', requiredFix: 'derive the jurisdiction at ingest',
  }));
  writeEsc('regintel/ingest.py');

  const invocations = join(dir, 'scoped-fix-invocations.txt');
  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export PRD_FILE=${JSON.stringify(prd)}`,
    `export LOG_DIR=${JSON.stringify(dir)}`,
    'export MAX_RETRIES=3',
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    'read_story_retry_count() { echo 0; }; write_story_retry_count() { :; }',
    'render_or_keep() { echo ""; }',
    // the scoped fix never converges — the live shape
    `implement_story() { printf '%s\\n' "$1" >> ${JSON.stringify(invocations)}; return 1; }`,
    shellFunction(HEALING, '_attempt_start_snapshot'),
    shellFunction(HEALING, '_restore_tree_snapshot'),
    shellFunction(LADDER, '_escalation_branch'),
    shellFunction(LADDER, '_escalation_worktree'),
    shellFunction(LADDER, '_escalation_adopt_work'),
    shellFunction(LADDER, 'resolve_escalation'),
    'resolve_escalation A-1; echo "RC1=$?"',
    // the same defect escalated a second time in the same run
    `cat > ${JSON.stringify(escFile)} <<'JSON'`,
    JSON.stringify({
      fromStoryId: 'A-1',
      targetFile: opts.secondTargetFile ?? 'regintel/ingest.py',
      diagnosis: 'RU-006 is still never deduplicated', requiredFix: 'derive the jurisdiction at ingest',
    }),
    'JSON',
    'resolve_escalation A-1; echo "RC2=$?"',
    'echo "AMENDMENT<<EOA"; printf "%s" "${COORDINATOR_PROMPT_AMENDMENT:-}"; echo; echo "EOA"',
  ].join('\n'));

  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const calls = existsSync(invocations) ? readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { out, calls, amendment: (out.split('AMENDMENT<<EOA')[1] ?? '').split('EOA')[0] ?? '' };
}

describe('an escalation already tried is not tried again', () => {
  it('REPRODUCES the cost: the same (story, file) escalation runs a second scoped fix', () => {
    const { calls } = escalateTwice();
    expect(calls.filter((c) => c === 'B-1').length,
      'the same scoped fix was re-run — a full writer attempt (~$0.66) for a result already known')
      .toBe(1);
  });

  it('hands the escalating story what happened last time, so it can try something else', () => {
    const { out, amendment } = escalateTwice();
    const said = out + amendment;
    expect(said, 'the repeat was skipped but the escalating story was told nothing').toMatch(/already|previous|last time|did not converge/i);
  });

  it('a DIFFERENT file is still escalated — only the repeat is withheld', () => {
    const { calls } = escalateTwice({ secondTargetFile: 'regintel/dedup.py' });
    expect(calls, 'a genuinely new escalation was suppressed').toContain('C-1');
  });

  it('nothing is discarded: the first attempt\'s worktree still exists', () => {
    const { out } = escalateTwice();
    expect(out).toMatch(/KEPT|worktree/i);
    // Not the fallback: "no worktree available" also contains "worktree".
    expect(out).not.toContain('no worktree available');
    expect(out).toMatch(/works in its own worktree \S+-esc-\S+ \(branch esc\/\S+\)/);
  });
});
