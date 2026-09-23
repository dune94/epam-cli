/**
 * A FAILED STORY'S COMMITS ARE KEPT, NOT ERASED.
 *
 * reset_brownfield_story_commit hard-resets the codeline to the phase baseline when a story fails
 * its gate:
 *
 *   [teardown] <story>: resetting <codeline> to pre-run baseline <sha> — discarding this story's
 *                       failed commit(s)
 *
 * The reason is sound: commit_completed_story() commits BEFORE the gate runs, so a gate failure
 * used to leave "story complete" sitting on the branch permanently, poisoning later semantic
 * search (AMSD-1820). The branch must not carry it.
 *
 * But `reset --hard` does not move the work aside — it destroys it. Everything the agent wrote,
 * including a diagnosis that was 90% right and the next attempt's only starting point, becomes
 * unreachable. In a pipeline where an agent's work is the expensive part, that is never
 * acceptable: keeping the branch clean and keeping the work are not in conflict — a ref costs
 * nothing.
 *
 * Executes the REAL function against a real repository.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const GUARDS = join(ROOT, 'orchestrations/scripts/lib/story-guards.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function teardown() {
  const dir = mkdtempSync(join(tmpdir(), 'failed-commit-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  writeFileSync(join(repo, 'app.py'), 'original\n');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD').stdout.trim();

  // the story's work, committed before its gate ran — exactly the live shape
  writeFileSync(join(repo, 'app.py'), 'the fix the agent spent eight attempts on\n');
  writeFileSync(join(repo, 'new_module.py'), 'a file only this story created\n');
  git('add', '-A'); git('commit', '-qm', 'S-9: story complete (2 file(s))');
  const storySha = git('rev-parse', 'HEAD').stdout.trim();

  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baseline + '\n');

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export LOG_DIR=${JSON.stringify(logDir)}`,
    'export EPAM_BROWNFIELD=1',
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    shellFunction(GUARDS, 'reset_brownfield_story_commit'),
    'reset_brownfield_story_commit S-9; echo "RC=$?"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  return {
    out: (r.stdout || '') + (r.stderr || ''),
    repo, baseline, storySha,
    git,
    /** is the story's commit still reachable from ANY ref? */
    reachable: () => {
      const refs = spawnSync('git', ['-C', repo, 'for-each-ref', '--format=%(objectname)'], { encoding: 'utf8' }).stdout || '';
      if (refs.includes(storySha)) return true;
      // or reachable from a ref's history
      const contains = spawnSync('git', ['-C', repo, 'branch', '--all', '--contains', storySha], { encoding: 'utf8' });
      return (contains.stdout || '').trim().length > 0;
    },
  };
}

describe("a failed story's commits are kept, not erased", () => {
  it('leaves the branch back at the baseline — the poisoning this exists to stop', () => {
    const t = teardown();
    expect(t.git('rev-parse', 'HEAD').stdout.trim(), 'the failed commit is still on the branch').toBe(t.baseline);
  });

  it("NEGATIVE: the story's commit is still reachable afterwards — the work is not destroyed", () => {
    const t = teardown();
    expect(t.reachable(), `the agent's commit was made unreachable:\n${t.out.slice(-400)}`).toBe(true);
  });

  it('NEGATIVE: the content is recoverable, not merely referenced', () => {
    const t = teardown();
    const show = spawnSync('git', ['-C', t.repo, 'show', `${t.storySha}:new_module.py`], { encoding: 'utf8' });
    expect(show.stdout, 'a file the story created cannot be recovered').toContain('a file only this story created');
  });

  it('says where the work was kept', () => {
    const t = teardown();
    expect(t.out, 'work was set aside but nothing said where to find it').toMatch(/kept|preserved|branch|ref/i);
  });
});
