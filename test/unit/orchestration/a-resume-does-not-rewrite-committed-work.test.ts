/**
 * A RESUME DOES NOT REWRITE COMMITTED WORK.
 *
 * AMSD-2974 run 9, resume 3 (2026-10-11 01:38Z): the lane restored its pre-writer checkpoint, whose PRD predates the
 * writer, so the story was "not completed" and the writer was invoked again — and answered, in its own words, "I didn't
 * need to change any code this turn: the earlier commit d429022 ('AMSD-2974: story complete') already contains all three
 * fixes." A paid writer call that changed nothing, followed by a full review. The rule: on resume, a story whose work is
 * committed in this run AND has no review rejection newer than that commit is completed — the writer skips it and the
 * review judges the committed change. A rejection newer than the commit still sends it back to the writer.
 *
 * EXECUTED: story_resume_completed_by_commit (lib/story-outputs.sh) on a real git repository: a phase baseline, the
 * pipeline's own commit convention ("<story>: …"), a review-feedback file older or newer than the commit.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');

function fixture(opts: { commitStory?: boolean; rejection?: 'older' | 'newer' | 'none'; otherStoryCommit?: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'resume-committed-'));
  const repo = join(d, 'repo'); const logs = join(d, 'logs'); mkdirSync(repo); mkdirSync(logs);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q'); writeFileSync(join(repo, 'a.ts'), 'a\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), String(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim());
  const commitTime = Math.floor(Date.now() / 1000) - 600;
  if (opts.commitStory || opts.otherStoryCommit) {
    writeFileSync(join(repo, 'a.ts'), 'fixed\n'); git('add', '.');
    const subject = opts.otherStoryCommit ? 'S-2: story complete (1 file(s))' : 'S-1: story complete (1 file(s))';
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', subject],
      { env: { ...process.env, GIT_COMMITTER_DATE: `${commitTime} +0000`, GIT_AUTHOR_DATE: `${commitTime} +0000` } });
  }
  if (opts.rejection && opts.rejection !== 'none') {
    const fb = join(logs, 'review-feedback-S-1.json');
    writeFileSync(fb, JSON.stringify({ verdict: 'changes_requested', issues: [{ severity: 'blocker' }] }));
    const t = opts.rejection === 'older' ? commitTime - 300 : commitTime + 300;
    utimesSync(fb, t, t);
  }
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', completed: false }] }));
  const r = spawnSync('bash', ['-c', `. "${S}/lib/story-outputs.sh"; story_resume_completed_by_commit "${repo}" "${logs}" "${prd}"`],
    { encoding: 'utf8' });
  return { completed: JSON.parse(readFileSync(prd, 'utf8')).stories[0].completed, out: `${r.stdout}${r.stderr}` };
}

describe('a resume does not rewrite committed work', () => {
  it('committed in this run, no rejection since: completed — the writer is not called again', () => {
    const r = fixture({ commitStory: true, rejection: 'older' });
    expect(r.completed, r.out).toBe(true);
  });

  it('committed, never reviewed yet: completed — the review judges the committed change', () => {
    expect(fixture({ commitStory: true, rejection: 'none' }).completed).toBe(true);
  });

  it('a rejection NEWER than the commit: still pending — the writer addresses it', () => {
    expect(fixture({ commitStory: true, rejection: 'newer' }).completed).toBe(false);
  });

  it('no commit for the story in this run: still pending — nothing to keep', () => {
    expect(fixture({ commitStory: false, rejection: 'none' }).completed).toBe(false);
  });

  it('another story\'s commit does not complete this one', () => {
    expect(fixture({ otherStoryCommit: true, rejection: 'none' }).completed).toBe(false);
  });
});
