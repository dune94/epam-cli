/**
 * CODEGRAPH INDEXING — 76 lines, no test, and it carried a client's naming habit as engine law.
 *
 * It skipped `docs.*` repositories as "not in maintenance scope". That is one project's convention
 * asserted over every project, and it fails in the direction of doing LESS, silently: on a project
 * whose product IS a documentation platform it would skip the work and report success. The same
 * literal was removed from codeline-discovery.js for the same reason — relocating it here did not
 * make it project data. Its header also named a client outright.
 *
 * A codeline is indexed if discovery resolved it and it is a git repository. That is the shape of
 * the thing, not a judgement about relevance.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/index-codelines.sh');

/** An estate of git repositories, plus anything else we want ignored. */
function estate(repos: string[], plain: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'estate-'));
  for (const r of repos) mkdirSync(join(root, r, '.git'), { recursive: true });
  for (const p of plain) mkdirSync(join(root, p), { recursive: true });
  return root;
}

function index(root: string, args: string[] = []) {
  const r = spawnSync('bash', [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8', timeout: 120_000,
    // A binary that does nothing: this asserts WHICH repositories are selected, not what the
    // indexer does with them.
    env: { ...process.env, CODEGRAPH_BIN: '/bin/true', EPAM_COVERAGE_GATED: '0' },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('indexing excludes nothing by name', () => {
  it('a docs.* repository IS indexed — one client naming habit is not engine law', () => {
    const root = estate(['docs.portal', 'api.service']);
    const r = index(root);
    expect(r.out, 'a repository was skipped because of its name')
      .not.toMatch(/SKIP \(docs\)/);
    expect(r.out, 'the docs repository was not considered at all').toContain('docs.portal');
  }, 180_000);

  it('and the source names no client', () => {
    // The header read "all Metrolinx codelines" — a project fact in engine code.
    const src = readFileSync(SCRIPT, 'utf8');
    const outsideComments = src.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(outsideComments.toLowerCase(), 'a client name is written into the engine')
      .not.toMatch(/metrolinx|gotransit|upexpress/);
  });

  it('a directory that is NOT a git repository is skipped, and says so', () => {
    // The shape of the thing: a codeline is a git repository, and one that is not cannot receive
    // work whatever it contains.
    const root = estate(['real.repo'], ['just-a-folder']);
    const r = index(root);
    expect(r.out, 'a non-repository was treated as a codeline').toMatch(/SKIP \(not git\)/);
    expect(r.out).toContain('just-a-folder');
  }, 180_000);

  it('every repository in the estate is considered, not just the first', () => {
    const root = estate(['a.repo', 'b.repo', 'c.repo']);
    const r = index(root);
    for (const n of ['a.repo', 'b.repo', 'c.repo']) {
      expect(r.out, `${n} was never considered`).toContain(n);
    }
  }, 180_000);

  it('an EMPTY estate is not a failure', () => {
    const r = index(estate([]));
    expect(r.code, 'an estate with no repositories was treated as an error').toBe(0);
  }, 180_000);

  it('an unknown flag is refused rather than silently ignored', () => {
    const r = index(estate(['a.repo']), ['--not-a-flag']);
    expect(r.code, 'an unknown flag was accepted, so a mis-typed --force would do nothing')
      .not.toBe(0);
  }, 180_000);

  it('--root overrides the environment, so a run indexes what it resolved', () => {
    const declared = estate(['from-flag.repo']);
    const other = estate(['from-env.repo']);
    const r = spawnSync('bash', [SCRIPT, '--root', declared], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, JIRA_CODELINE_ROOT: other, CODEGRAPH_BIN: '/bin/true',
        EPAM_COVERAGE_GATED: '0' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, '--root did not override the environment').toContain('from-flag.repo');
    expect(out, 'it indexed the environment root instead of the one it was given')
      .not.toContain('from-env.repo');
  }, 180_000);
});
