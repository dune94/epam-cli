/**
 * A CODELINE THAT DECLARES A LINTER IS LINTED — HOOK OR NO HOOK.
 *
 * run_repo_lint_verification asks for a pre-commit hook first and RETURNS when there is none:
 *
 *     if [ -z "$_hook" ]; then
 *         warning "  [repo-lint] no pre-commit hook … lint was NOT run"
 *         return 0
 *     fi
 *     …
 *     if [ -n "$_declared_lint" ]; then …            <- never reached without a hook
 *
 * So the declared-lint path below it — the one that runs whatever the codeline declares in
 * .epam/verification.json, written precisely for codelines that lint with something other than
 * eslint — is unreachable on any repo without a hook. Live 2026-09-23: seven "lint was NOT run"
 * warnings in a single story run on a codeline that had no hook, and would not have been linted
 * even if it had declared a linter.
 *
 * Executes the REAL function against a real git repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const EV = join(ROOT, 'orchestrations/scripts/lib/external-verification.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function lintRun(opts: { declaredLint?: string; hook?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-gate-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'thing.py'), 'x = 1\n');
  // the codeline's own ecosystem, so its source files are recognised as source
  writeFileSync(join(repo, 'requirements.txt'), `pytest\n${opts.declaredLint ? 'ruff\n' : ''}`);
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'base');
  writeFileSync(join(repo, 'src', 'thing.py'), 'x = 2\n');   // a change for lint to judge

  const ran = join(dir, 'lint-ran.txt');
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({
    test: { command: 'true' },
    ...(opts.declaredLint ? { lint: { command: `sh -c 'echo ran >> ${ran}'` } } : {}),
  }));
  if (opts.hook) {
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    const h = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(h, '#!/bin/sh\nexit 0\n'); chmodSync(h, 0o755);
  }

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export LOG_DIR=${JSON.stringify(dir)}`,
    `export AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}`,
    `export SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`,
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    'evidence_window() { echo 500; }',
    'changed_source_files() { echo "src/thing.py"; }',
    'engine_paths_filter() { cat; }',
    'is_truthy() { [ "${1:-}" = "1" ] || [ "${1:-}" = "true" ]; }',
    shellFunction(EV, '_run_declared_lint_gate'),
    shellFunction(EV, 'run_repo_lint_verification'),
    'run_repo_lint_verification "S-1"; echo "rc=$?"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 40000 });
  const out = (r.stdout || '') + (r.stderr || '');
  let linted = false;
  try { linted = require('node:fs').existsSync(ran); } catch { linted = false; }
  return { out, linted };
}

describe('a codeline that declares a linter is linted', () => {
  it('runs the DECLARED linter even with no pre-commit hook', () => {
    const { out, linted } = lintRun({ declaredLint: 'yes', hook: false });
    expect(linted, `the declared linter never ran — the hook check returned first:\n${out.slice(-400)}`).toBe(true);
  });

  it('still says so when the codeline declares nothing and has no hook', () => {
    const { out, linted } = lintRun({ hook: false });
    expect(linted).toBe(false);
    expect(out, 'an absent check passed silently').toMatch(/lint was NOT run|declares no/i);
  });
});
