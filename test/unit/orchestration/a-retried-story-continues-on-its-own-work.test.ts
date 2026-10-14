/**
 * A RETRIED STORY CONTINUES ON ITS OWN WORK — ITS BRANCH IS NEVER RESET UNDER IT, AND NOTHING IS ORPHANED UNRESCUED.
 *
 * AMSD-2974 run 9 (2026-10-14 02:04Z): a self-heal retry sets the story pending; ensure_story_branch then hard-reset the
 * 7.x line's branch to v7.11.0 — twice in one run — discarding the approved full port (c25e819), and the writer rewrote it
 * from nothing. The rescue measured HEAD only; the line's branch was not HEAD (cx-shared was on its 8.x branch), so the
 * approved commits were left on no ref at all.
 *
 * EXECUTED: the real ensure_story_branch (lib/git-ops.sh) on a real repository with a release tag as the base, a line
 * branch that is not HEAD, and this run's story-changes record.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GITOPS = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const PERIM = join(ROOT, 'orchestrations/scripts/lib/codeline-write-perimeter.sh');
const CK = join(ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { spawnSync('bash', ['-c', `. "${PERIM}"; perimeter_unlock "${d}/repo"`]); rmSync(d, { recursive: true, force: true }); } });

function estate(record: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'retry-own-work-')); dirs.push(d);
  const repo = join(d, 'repo'); const logs = join(d, 'logs'); mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(logs);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'src/Toast.tsx'), 'v7\n');
  git('init', '-q', '-b', 'main-line'); git('add', '.'); git('commit', '-qm', 'base'); git('tag', 'v7.11.0');
  // The line's story branch with its approved port, NOT checked out (the codeline sits on its own line's branch).
  git('checkout', '-qb', 'AI-S-1-7.x');
  writeFileSync(join(repo, 'src/Toast.tsx'), 'v7 + approved full port\n'); git('commit', '-qam', 'S-1: story complete (1 file(s))');
  const approved = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main-line');
  if (record) writeFileSync(join(logs, 'story-changes.jsonl'), `${JSON.stringify({ storyId: 'S-1', sha: approved })}\n`);
  return { repo, logs, approved, git };
}

function ensure(e: { repo: string; logs: string }, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', [
    'warning(){ echo "WARN: $*"; }; error(){ echo "ERROR: $*"; }; success(){ echo "OK: $*"; }; info(){ echo "INFO: $*"; }; log(){ :; }',
    `. "${PERIM}"`, `. "${CK}"`, `. "${GITOPS}"`,
    `ensure_story_branch "${e.repo}" S-1 v7.11.0; echo "RC=$?"`].join('\n')],
  { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1', EPAM_BRANCH_SUFFIX: '-7.x', LOG_DIR: e.logs, ...env } });
}

describe('a retried story continues on its own work', () => {
  it('the retry of a story this run already committed stays on its branch tip — the approved port is kept', () => {
    const e = estate(true);
    const r = ensure(e);
    expect(r.stdout, r.stdout + r.stderr).toContain('continuing on its own work');
    expect(e.git('rev-parse', 'AI-S-1-7.x')).toBe(e.approved);
    expect(e.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('AI-S-1-7.x');
  });

  it('NEGATIVE: no record of this story in this run — the branch is based afresh, and its commits are RESCUED though it was not HEAD', () => {
    const e = estate(false);
    const r = ensure(e);
    expect(e.git('rev-parse', 'AI-S-1-7.x')).toBe(e.git('rev-parse', 'v7.11.0^{commit}'));
    const rescued = e.git('branch', '--list', 'epam-rescue/*', '--format=%(objectname)');
    expect(rescued.split('\n'), r.stdout).toContain(e.approved);
  });

  it('NEGATIVE: a resume sent back to an earlier stage starts the story over (and rescues what it replaces)', () => {
    const e = estate(true);
    ensure(e, { EPAM_RESUME_FROM_STAGE: 'post-roster' });
    expect(e.git('rev-parse', 'AI-S-1-7.x')).toBe(e.git('rev-parse', 'v7.11.0^{commit}'));
    expect(e.git('branch', '--list', 'epam-rescue/*', '--format=%(objectname)').split('\n')).toContain(e.approved);
  });
});
