/**
 * A DECLARED DIRECTORY DELIVERABLE IS A DIRECTORY, AND A DOT-PATH IS NOT A GLOB.
 *
 * REGI-001 declared `dial/` and `docs/` among its deliverables; both existed with contents, and
 * the deliverable check reported them missing — _resolve_deliverable_path accepts a FILE only. It
 * also reported `.venv/` "ambiguous — 2 files match: .env.example …": its extension-less fallback
 * strips from the LAST dot of the whole path, so for a dot-named entry the stem is the parent
 * directory and `stem.*` matches every dotfile beside it. A correct implementation was failed
 * twice, HealingBroken declared, the analyst invoked, the ladder about to climb — on a check that
 * could not pass (regintel run 20260915T101555Z, 2026-09-15, $0.32). Executed through the real
 * function from claude.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function resolve(abs: string) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(CLAUDE)} >/dev/null 2>&1; warning(){ echo "WARN $*" >&2; }; log(){ :; }; _resolve_deliverable_path ${JSON.stringify(abs)}`],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0' } });
  return { status: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
}

describe('a declared directory deliverable is a directory, and a dot-path is not a glob', () => {
  const root = mkdtempSync(join(tmpdir(), 'deliv-')); dirs.push(root);
  mkdirSync(join(root, 'dial')); writeFileSync(join(root, 'dial', 'client.py'), 'x = 1\n');
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true }); writeFileSync(join(root, '.venv', 'bin', 'python'), '#!/bin/sh\n');
  writeFileSync(join(root, '.env.example'), 'A=1\n');
  writeFileSync(join(root, 'store.py'), 'y = 2\n');

  it('a declared directory that exists with contents resolves (trailing slash or not)', () => {
    expect(resolve(join(root, 'dial/')).status, 'dial/ reported missing').toBe(0);
    expect(resolve(join(root, 'dial')).status).toBe(0);
  });
  it('an empty directory does not resolve — nothing was delivered there', () => {
    expect(resolve(join(root, 'empty/')).status).not.toBe(0);
  });
  it('a dot-named directory is not matched against its siblings', () => {
    const r = resolve(join(root, '.venv/'));
    expect(r.status, r.err).toBe(0);
    expect(r.err).not.toMatch(/ambiguous/);
    // and it resolves to ITSELF — not, silently, to a sibling dotfile the fallback glob happened to hit
    expect(r.out).toBe(join(root, '.venv'));
  });
  it('a plain file still resolves, an extension-less declaration still finds its one file, and a missing file still fails', () => {
    expect(resolve(join(root, 'store.py')).status).toBe(0);
    expect(resolve(join(root, 'store')).out).toBe(join(root, 'store.py'));
    expect(resolve(join(root, 'nothing.py')).status).not.toBe(0);
  });
});
