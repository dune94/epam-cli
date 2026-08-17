/**
 * THE ENGINE WAS COMMITTING ITS OWN REVIEW MARKDOWN INTO THE CUSTOMER'S REPOSITORY.
 *
 * Review artefacts were written to $PROJECT_ROOT/review/<story>-review.md. That directory is not
 * in _ENGINE_OWNED_DIRS, so engine_paths_filter let it through and git_add_client_outputs staged
 * it — while .epam/ and orchestrations/ were correctly excluded. Every run added engine output to
 * the client's history.
 *
 * The obvious fix is the wrong one. Adding "review" to _ENGINE_OWNED_DIRS would exclude it by
 * whole path segment, and "review" is generic enough that a client repo may legitimately have one
 * — their work would then be silently dropped from every commit, which is far worse than the
 * defect. .epam/ is already engine-owned and claims no new name.
 *
 * The same step created $PROJECT_ROOT/public/ in every project: a web-frontend convention,
 * meaningless to a library, a service or a Rust crate, and read by nothing in this pipeline. The
 * comment directly above it already condemned exactly this ("a client-named subdirectory here was
 * created in EVERY project the engine ran") — one level of generality down.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const GIT_OPS = join(SCRIPTS, 'lib/git-ops.sh');
const ENGINE_PATHS = join(SCRIPTS, 'lib/engine-paths.sh');
const NODE = process.execPath;

const code = () => readFileSync(ORCH, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'perimeter-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});

/** A client repo carrying client code and engine output side by side. */
function repo(files: Record<string, string>): string {
  const dir = join(work, 'repo');
  spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  for (const f of Object.keys(files)) appendFileSync(join(dir, f), 'CHANGED\n');
  return dir;
}

/** What git_add_client_outputs would actually commit. */
function staged(dir: string): string[] {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(GIT_OPS)}; git_add_client_outputs ${JSON.stringify(dir)} >/dev/null 2>&1; `
    + `git -C ${JSON.stringify(dir)} diff --cached --name-only`,
  ], { encoding: 'utf8', env: { ...process.env, NODE_BIN: NODE } });
  return r.stdout.split('\n').filter(Boolean);
}

describe('engine artefacts stay out of the client repo', () => {
  it('a review artefact under .epam is not committed', () => {
    const files = staged(repo({
      'src/a.ts': 'code\n',
      '.epam/review/STORY-1-review.md': '# review\n',
    }));
    expect(files, 'the client change was dropped').toContain('src/a.ts');
    expect(files.filter((f) => f.startsWith('.epam/')),
      'engine review output is still committed into the client repository').toEqual([]);
  });

  it('the old location is what would have been committed', () => {
    // Pins the defect rather than describing it: review/ is NOT engine-owned.
    const files = staged(repo({ 'src/a.ts': 'code\n', 'review/STORY-1-review.md': '# review\n' }));
    expect(files, 'a top-level review/ no longer reaches the commit — re-derive this fix')
      .toContain('review/STORY-1-review.md');
  });

  it('a CLIENT’s own review/ directory is still committed', () => {
    // Why "review" must NOT be added to _ENGINE_OWNED_DIRS: that list matches whole path
    // segments, so it would silently drop the customer's work from every commit.
    const owned = readFileSync(ENGINE_PATHS, 'utf8');
    expect(owned, '"review" was added to the engine-owned list — a client review/ is now dropped')
      .not.toMatch(/_ENGINE_OWNED_DIRS=\([^)]*'review'/);
    expect(staged(repo({ 'review/design-notes.md': 'ours\n' })))
      .toContain('review/design-notes.md');
  });

  it('the pipeline writes review artefacts inside the perimeter', () => {
    const body = code();
    expect(body, 'a review artefact is still written to the client tree root')
      .not.toMatch(/PROJECT_ROOT\/review\//);
    expect(body, 'review artefacts are no longer written under .epam')
      .toMatch(/PROJECT_ROOT\/\.epam\/review\//);
  });

  it('both the writer and the stale-artefact check agree on the location', () => {
    // They are read/written by different steps; a mismatch means the staleness check silently
    // stops finding anything and every review reads as fresh.
    const body = code();
    const sites = body.split('\n').filter((l) => /review\/\$\{[_a-z]+\}-review\.md/.test(l));
    expect(sites.length, 'expected the writer and the staleness check').toBeGreaterThanOrEqual(2);
    for (const line of sites) {
      expect(line, `a review path outside the perimeter: ${line.trim()}`).toContain('.epam/review/');
    }
  });

  it('no web-frontend directory is created in every project', () => {
    const body = code();
    expect(body, 'public/ is still created in every repository the engine touches')
      .not.toMatch(/PROJECT_ROOT\/public/);
  });
});
