// THE ONE TIER-A GATE THAT PASSED ON A STATE IT DESCRIBED AS UNPROVEN.
//
// run_repo_lint_verification (claude.sh:5210) discovered its linter by probing:
//
//     for _candidate in "$PROJECT_ROOT/node_modules/.bin/eslint" "$(command -v eslint)"; do
//     ...
//     if [ -z "$_eslint_bin" ]; then
//         warning "no eslint binary ... lint was NOT run; nothing here proves the change is clean"
//         return 0
//     fi
//
// On any codeline that does not lint with eslint it finds nothing, says in its own words that
// nothing proves the change is clean, and RETURNS 0. It carries the delivery contract
// (DETERMINISTIC_CHECK_FAILURE / VERIFICATION_FAILURE) — one of seventeen functions that do — and
// it is the only one of them coupled to a stack.
//
// Three facts already had a home: .epam/verification.json declares `typecheck` and `test` the same
// way, detected by the plugin that owns detection. Lint is the third of the same shape.
//
// THE HOOK DISCOVERY ABOVE IT IS THE MODEL and is left alone: it reads core.hooksPath from git,
// then .husky/, then .git/hooks — no stack assumption anywhere in it.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const PLUGIN = join(ROOT, 'orchestrations/plugins/verification-plugin.js');
const CLAUDE = join(ROOT, 'orchestrations/scripts/claude.sh');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'lint-')); made.push(d); return d; }

/** What the plugin detects for a repository, as the plugin itself sees it. */
function detect(root: string): Record<string, unknown> | null {
  const r = spawnSync(NODE, ['-e',
    `const p=require(${JSON.stringify(PLUGIN)});
     const fn = p.detectLint;
     if (typeof fn !== 'function') { process.stdout.write('NO_DETECTLINT'); process.exit(0); }
     process.stdout.write(JSON.stringify(fn(process.argv[1]) || null));`, root,
  ], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (out === 'NO_DETECTLINT') throw new Error('verification-plugin.js exports no detectLint');
  return out ? JSON.parse(out) : null;
}

/**
 * The gate function, lifted out of claude.sh into a file that can be sourced.
 *
 * The established pattern for a shell function in an 11,000-line script that cannot be sourced
 * whole: take the real text, run the real thing. Not a reimplementation here, which would pass no
 * matter what the engine does.
 */
let _fnPath = '';
function fnFile(): string {
  if (_fnPath) return _fnPath;
  const src = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('_run_declared_lint_gate() {'));
  if (start < 0) throw new Error('_run_declared_lint_gate is not in claude.sh');
  let end = start + 1;
  while (end < src.length && src[end] !== '}') end += 1;
  const d = tmp();
  _fnPath = join(d, 'fn.sh');
  writeFileSync(_fnPath, src.slice(start, end + 1).join('\n') + '\n');
  return _fnPath;
}

describe('lint is detected the way typecheck and test already are', () => {
  it('the plugin exports detectLint alongside its siblings', () => {
    const src = readFileSync(PLUGIN, 'utf8');
    expect(src).toMatch(/function detectLint/);
    const exportBlock = src.slice(src.lastIndexOf('module.exports'));
    expect(exportBlock, 'detectLint is not exported, so nothing can call it').toMatch(/\bdetectLint\b/);
  });

  it("finds the project's OWN lint script rather than a tool this pipeline prefers", () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { lint: 'biome check .' } }));
    const d = detect(root) as { lint: { command: string; detected: string } };
    expect(d.lint.command).toBe('npm run lint');
    expect(d.lint.detected).toMatch(/package\.json scripts\.lint/);
  });

  it('follows the package manager the lockfile names', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'x' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    expect((detect(root) as { lint: { command: string } }).lint.command).toBe('pnpm lint');
  });

  it('returns NOTHING rather than guessing when the project declares no lint', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'x' } }));
    expect(detect(root), 'a lint command was invented for a project that declares none').toBeNull();
  });

  it('and NOTHING for a repository of another ecosystem it cannot read', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'requests\n');
    expect(detect(root)).toBeNull();
  });
});

describe('the gate runs what the codeline declares', () => {
  /** Run the real guard against a fixture repo, with a stubbed linter on PATH. */
  function lint(opts: { declare?: string; hook?: boolean; stub?: string; env?: NodeJS.ProcessEnv }) {
    const root = tmp();
    spawnSync('git', ['init', '-q', root]);
    spawnSync('git', ['-C', root, 'config', 'user.email', 't@t']);
    spawnSync('git', ['-C', root, 'config', 'user.name', 't']);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    // A real codeline carries a manifest; that is what resolves its source extensions.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    if (opts.hook !== false) {
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    if (opts.declare) {
      mkdirSync(join(root, '.epam'), { recursive: true });
      writeFileSync(join(root, '.epam', 'verification.json'),
        JSON.stringify({ lint: { command: opts.declare, detected: 'fixture' } }));
    }
    const bin = tmp();
    writeFileSync(join(bin, 'fixturelint'), `#!/usr/bin/env bash\n${opts.stub ?? 'exit 0'}\n`, { mode: 0o755 });

    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       export PATH=${JSON.stringify(bin)}:$PATH
       SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
       PROJECT_ROOT=${JSON.stringify(root)}
       AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}
       LOG_DIR=$(mktemp -d)
       warning() { echo "WARN: $*"; }; error() { echo "ERROR: $*" >&2; }
       success() { echo "OK: $*"; }; info() { echo "INFO: $*"; }; log() { echo "LOG: $*"; }
       is_truthy() { case "\${1:-}" in 1|true|TRUE|yes) return 0;; *) return 1;; esac; }
       engine_paths_filter() { cat; }
       source ${JSON.stringify(fnFile())}
       _run_declared_lint_gate STORY-1 /dev/null "\${DECLARED:-}"; echo "RC=$?"`,
    ], { encoding: 'utf8', env: { ...process.env, DECLARED: opts.declare ?? '', ...(opts.env || {}) } });
    return (r.stdout || '') + (r.stderr || '');
  }

  it('runs the declared command and passes when it is clean', () => {
    const out = lint({ declare: 'fixturelint', stub: 'exit 0' });
    expect(out).toMatch(/OK:/);
    expect(out).toMatch(/RC=0/);
  });

  it('BLOCKS when the declared command rejects the change', () => {
    const out = lint({ declare: 'fixturelint', stub: 'echo "src/a.ts: no-explicit-any" >&2; exit 1' });
    expect(out).toMatch(/ERROR:/);
    expect(out).not.toMatch(/RC=0/);
  });

  it('does not require eslint to exist', () => {
    // The whole point: a codeline whose linter is biome, ruff or golangci-lint is still gated.
    const out = lint({ declare: 'fixturelint', stub: 'exit 0' });
    expect(out).not.toMatch(/eslint/i);
  });

  it('FAILS rather than skipping when the declared command cannot be run', () => {
    // Declared-but-unrunnable is the state the eslint probe could not express: it treated "no
    // linter here" and "this project lints and I could not run it" as the same silent pass.
    const out = lint({ declare: 'no-such-linter-anywhere' });
    expect(out).toMatch(/ERROR:|WARN:/);
    expect(out).not.toMatch(/RC=0/);
  });
});
