/**
 * A VALUE DETECTION WROTE IS NOT A HAND-TUNING, SO IT MUST NOT OUTRANK DETECTION.
 *
 * .epam/verification.json is written by layering: detected < project-declared < whatever is
 * already in the codeline's file. The last layer exists so an operator can tune a command for one
 * run and win. But the file's FIRST content was written by detection itself, and it then
 * outranked detection forever.
 *
 * Live, regintel 2026-09-23: the file has said test.command "pytest" since the codeline was
 * created. The ecosystem's command was corrected to `python3 -m pytest` — without which the suite
 * cannot import the package it tests, and every external verification exited 2 with zero tests
 * collected — and the fix could not reach the codeline, because the stale detected value won.
 * A greenfield RESUME keeps its codeline, so the file is never rebuilt; git-ops.sh assumed "this
 * whole file is destroyed before every run", which is true only of brownfield's `git clean -fd`.
 *
 * Detection stamps each section it writes with `detected`. A section carrying that stamp is
 * detection's own and yields to fresh detection; a section without it was authored by a human or
 * a project declaration and still wins.
 *
 * Executes the REAL writer (_epam_write_verification_manifest, lib/git-ops.sh).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const GIT_OPS = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function write(existing: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), 'verif-precedence-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, 'requirements.txt'), 'pytest\n');
  if (existing) writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify(existing, null, 2));

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}`,
    `export NODE_BIN=${JSON.stringify(process.execPath)}`,
    'log() { :; }; warning() { :; }; error() { echo "ERR: $*"; }; info() { :; }',
    shellFunction(GIT_OPS, '_epam_write_verification_manifest'),
    `_epam_write_verification_manifest ${JSON.stringify(repo)}`,
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  let out: any = {};
  try { out = JSON.parse(readFileSync(join(repo, '.epam', 'verification.json'), 'utf8')); } catch { out = {}; }
  return { out, log: (r.stdout || '') + (r.stderr || '') };
}

describe('a detected value does not outrank detection', () => {
  it('writes what the ecosystem detects when the file does not exist yet', () => {
    const { out, log } = write(null);
    expect(out?.test?.command, `nothing was written: ${log.slice(-300)}`).toContain('pytest');
    expect(out.test.detected, 'detection did not stamp its own work').toBeTruthy();
  });

  it('REPLACES a stale value that detection itself wrote', () => {
    const { out } = write({ test: { command: 'pytest', detected: 'requirements.txt via the requirements.txt ecosystem provider' } });
    expect(out.test.command, 'the stale detected command outranked fresh detection').toBe('python3 -m pytest');
  });

  it('KEEPS a value nobody detected — a hand-tuning still wins', () => {
    const { out } = write({ test: { command: 'pytest -x --tb=short' } });
    expect(out.test.command, "an operator's own command was overwritten").toBe('pytest -x --tb=short');
  });

  it('keeps a hand-tuned section while refreshing a detected one', () => {
    const { out } = write({
      test: { command: 'pytest', detected: 'requirements.txt via the requirements.txt ecosystem provider' },
      typecheck: { command: 'mypy --strict .' },
    });
    expect(out.test.command).toBe('python3 -m pytest');
    expect(out.typecheck.command, 'a hand-tuned typecheck was lost').toBe('mypy --strict .');
  });
});
