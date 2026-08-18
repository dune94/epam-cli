/**
 * TWO HAND-WRITTEN LISTS DECIDED WHAT A CLIENT REPOSITORY RECEIVES, AND THEY HAD DRIFTED.
 *
 * worktree-health-check.sh named `.dart_tool`, `build`, `node_modules`. lib/git-ops.sh named
 * `node_modules`, `build`, `.next`. Between them they described one ecosystem.
 *
 * The damage ran both ways. `git_add_client_outputs` decides what is COMMITTED TO THE CUSTOMER'S
 * REPO: on a Rust codeline whose target/ was not gitignored, the build tree was staged into it. And
 * the health check's list decides what counts as the agent's uncommitted work — the same directory
 * was reported as thousands of uncommitted files, which set issues=1, which made Step 3.1 exit 1
 * and killed the phase.
 *
 * These run the real git staging and the real health check against real repositories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GIT_OPS = join(SCRIPTS, 'lib/git-ops.sh');
const HEALTH = join(SCRIPTS, 'worktree-health-check.sh');
const NODE = process.execPath;
const ENV = { ...process.env, NODE_BIN: NODE };

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'never-agent-output-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** A repo with NO .gitignore — the shape where the exclusion list is the only thing acting. */
function repo(files: Record<string, string>): string {
  const dir = join(work, 'repo');
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
    encoding: 'utf8',
    env: { ...ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
  writeFileSync(join(dir, 'README.md'), '# r\n');
  g('add', 'README.md'); g('commit', '-m', 'init', '--quiet');
  return dir;
}

/** Stage via the real function, then report what git actually put in the index. */
function stagedBy(dir: string): string[] {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(GIT_OPS)}; git_add_client_outputs ${JSON.stringify(dir)} >/dev/null 2>&1; ` +
    `git -C ${JSON.stringify(dir)} diff --cached --name-only`,
  ], { encoding: 'utf8', env: ENV });
  return r.stdout.split('\n').filter(Boolean);
}

describe('what is never agent output is one list', () => {
  it('does not stage a Rust build tree into the customer’s repository', () => {
    const dir = repo({
      'src/lib.rs': 'pub fn f() {}\n',
      'Cargo.toml': '[package]\nname = "x"\n',
      'target/debug/blob': 'x'.repeat(200),
    });
    const staged = stagedBy(dir);
    expect(staged, 'the real source change was not staged — the filter is now too wide, which loses work')
      .toContain('src/lib.rs');
    expect(staged.filter((f) => f.startsWith('target/')),
      'the Rust build tree was staged into the client repository',
    ).toEqual([]);
  });

  it('does not stage a Python virtualenv or bytecode cache', () => {
    const dir = repo({
      'app.py': 'x = 1\n',
      'pyproject.toml': '[project]\nname = "x"\n',
      '.venv/lib/thing': 'x',
      '__pycache__/app.cpython-311.pyc': 'x',
    });
    const staged = stagedBy(dir);
    expect(staged).toContain('app.py');
    expect(staged.filter((f) => f.startsWith('.venv/') || f.startsWith('__pycache__/'))).toEqual([]);
  });

  it('still stages directories no ecosystem owns — an exclusion that is too wide loses real work', () => {
    // The one-directional bias. `vendor/` is committed by convention in Go, and `bin/` and `tmp/`
    // carry tracked files in plenty of repos; filtering them on a customer's behalf discards agent
    // output SILENTLY, which is worse than staging something visible in a diff.
    const dir = repo({
      'go.mod': 'module x\n',
      'vendor/dep/dep.go': 'package dep\n',
      'bin/tool.sh': '#!/bin/sh\n',
    });
    const staged = stagedBy(dir);
    expect(staged, 'vendor/ was filtered out, silently discarding committed-by-convention code')
      .toContain('vendor/dep/dep.go');
    expect(staged).toContain('bin/tool.sh');
  });

  it('excludes a top-level artefact directory, not only a nested one', () => {
    // `:!*​/node_modules/*` matches only a NESTED one. A top-level node_modules — the usual case —
    // needs its own pathspec, and the original list carried only the nested form.
    const dir = repo({ 'index.js': 'module.exports = 1\n', 'package.json': '{"name":"x"}', 'node_modules/dep/i.js': 'x' });
    expect(stagedBy(dir).filter((f) => f.startsWith('node_modules/'))).toEqual([]);
  });

  it('the health check does not report a build tree as the agent’s uncommitted work', () => {
    const dir = repo({ 'Cargo.toml': '[package]\nname = "x"\n', 'target/debug/blob': 'x' });
    const r = spawnSync('bash', [HEALTH], {
      encoding: 'utf8', env: { ...ENV, GIT_WORK_ROOT: dir, PHASE: 'test', AUTO_COMMIT: 'false' },
    });
    expect(`${r.stdout}${r.stderr}`, 'target/ was reported as uncommitted agent output, which fails the phase')
      .not.toMatch(/target\/debug/);
  });

  it('neither shell file names an ecosystem artefact of its own any more', () => {
    for (const f of [GIT_OPS, HEALTH]) {
      const body = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      for (const lit of ['node_modules', '.dart_tool', '.next']) {
        expect(body, `${f.split('/').pop()} still names ${lit} in its own code`).not.toContain(lit);
      }
    }
  });

  it('refuses to stage at all when the list cannot be resolved', () => {
    // A silent fallback to an empty exclusion list stages the customer's whole build tree.
    const dir = repo({ 'a.txt': 'x' });
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(GIT_OPS)}; git_add_client_outputs ${JSON.stringify(dir)}; echo "rc=$?"`,
    ], { encoding: 'utf8', env: { ...ENV, NODE_BIN: '/nonexistent/node' } });
    expect(r.stdout, 'staging proceeded with no exclusions when the handler could not run')
      .toContain('rc=1');
  });
});
