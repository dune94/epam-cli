/**
 * A FIX THE REVIEWER VERIFIED IS A CHANGE.
 *
 * AMSD-2974 run 9, resume 10 (2026-10-13 11:5xZ): the cxshared 7.x back-port was rejected with one blocker (the close
 * button had no accessible name); the writer committed a one-line fix; the reviewer approved it, quoting the changed
 * line. The verdict-flip rule then escalated it — "approved … with the codeline UNCHANGED since that rejection" —
 * because _review_tree_fingerprint (lib/phase-assessment.sh) hashed only `git diff HEAD` (uncommitted edits) of the
 * repositories under JIRA_CODELINE_ROOT (~/projects/tests/codelines). The lane worked in ~/projects/metrolinx/cx-shared
 * and the writer COMMITS its work, so the fingerprint could never move.
 *
 * EXECUTED: the real _review_tree_fingerprint and _review_approval_is_giveup on real git repositories — the lane's
 * codeline (PROJECT_ROOT) outside JIRA_CODELINE_ROOT, a fix committed between two review cycles. NEGATIVE: an approval
 * with nothing changed at all is still a give-up.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/phase-assessment.sh');
const FNS = ['_review_tree_fingerprint', '_review_approval_is_giveup'].map((n) => shellFunction(LIB, n)).join('\n');

function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q'); writeFileSync(join(dir, 'Toast.tsx'), 'aria-label={ariaLabel}\n'); git('add', '.'); git('commit', '-qm', 'base');
  return git;
}

function fingerprint(env: Record<string, string>) {
  const r = spawnSync('bash', ['-c', `${FNS}\n_review_tree_fingerprint`], { encoding: 'utf8', env: { PATH: process.env.PATH || '', ...env } });
  return r.stdout.trim();
}
const giveup = (prev: string, now: string) =>
  spawnSync('bash', ['-c', `${FNS}\n_review_approval_is_giveup 1 ${JSON.stringify(prev)} ${JSON.stringify(now)} && echo giveup || echo stands`], { encoding: 'utf8' }).stdout.trim();

function estate() {
  const d = mkdtempSync(join(tmpdir(), 'verdict-flip-'));
  const lane = join(d, 'metrolinx', 'cx-shared');            // where the lane works
  const other = join(d, 'tests', 'codelines', 'unrelated');  // what JIRA_CODELINE_ROOT holds
  const gitLane = repo(lane); repo(other);
  return { lane, gitLane, env: { PROJECT_ROOT: lane, JIRA_CODELINE_ROOT: join(d, 'tests', 'codelines') } };
}

describe('a fix the reviewer verified is a change', () => {
  it('a fix COMMITTED in the lane\'s codeline between two review cycles moves the fingerprint — the approval stands', () => {
    const e = estate();
    const before = fingerprint(e.env);
    writeFileSync(join(e.lane, 'Toast.tsx'), 'aria-label={ariaLabel ?? "Close notification"}\n');
    e.gitLane('commit', '-qam', 'AMSD-2974: story complete (1 file(s))');
    const after = fingerprint(e.env);
    expect(before, 'the fingerprint is empty — nothing below is a fact').toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
    expect(giveup(before, after)).toBe('stands');
  });

  it('an UNCOMMITTED edit in the lane\'s codeline moves it too', () => {
    const e = estate();
    const before = fingerprint(e.env);
    writeFileSync(join(e.lane, 'Toast.tsx'), 'aria-label={ariaLabel ?? "Close"}\n');
    expect(fingerprint(e.env)).not.toBe(before);
  });

  it('NEGATIVE: nothing changed anywhere — the approval after a blocker is still a give-up', () => {
    const e = estate();
    const before = fingerprint(e.env);
    const after = fingerprint(e.env);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(giveup(before, after)).toBe('giveup');
  });
});
