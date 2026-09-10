/**
 * AN INSTALL INTO A THROWAWAY DEST KILLED THE MACHINE'S `epam` COMMAND.
 *
 * install.sh writes the shim to $HOME/.local/bin/epam by default and overwrites whatever is there,
 * pointing it at the dest being installed. Any install into a temporary directory therefore
 * hijacks the machine-wide command, and the moment that directory is removed the command is dead:
 *
 *     $ epam --version
 *     Error: Cannot find module '/tmp/installer-creds-f7Uyoe/dist/epam.js'
 *
 * Found live 2026-09-09 — the operator's `epam` had been repointed at a temp dest by an install
 * test hours earlier and had been broken ever since, with nothing said at the time. Most of the
 * test files that invoke install.sh do not set EPAM_BIN_DIR, so this happens routinely.
 *
 * Two guarantees, and neither downgrades the install: the shim still lands in BIN_DIR and `epam`
 * still works after a normal install.
 *
 *   1. A shim already pointing at a DIFFERENT root is backed up before it is replaced, so a
 *      working command can always be restored — an install may take over the name, but it may not
 *      destroy what was there without a trace.
 *   2. The shim reports a missing target itself, naming the install that vanished, instead of
 *      failing with a node module-resolution stack that says nothing about the cause.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const INSTALL = join(ROOT, 'orchestrations-installer/install.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Just the shim block of install.sh, run against a sandboxed BIN_DIR. */
function runShimBlock(opts: { root: string; binDir: string }) {
  const src = readFileSync(INSTALL, 'utf8').split('\n');
  const start = src.findIndex((l) => /^_head "Command"$/.test(l));
  expect(start, 'the Command section is gone from install.sh').toBeGreaterThan(-1);
  const end = src.findIndex((l, i) => i > start && /^_head "Project"$/.test(l));
  const block = src.slice(start, end).join('\n');

  const d = tmp('shim-');
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash
set -uo pipefail
_head(){ echo "== $*"; }; _ok(){ echo "OK: $*"; }; _warn(){ echo "WARN: $*"; }
CHECK_ONLY=0
ROOT="${opts.root}"
EPAM_BIN_DIR="${opts.binDir}"
${block}
`);
  return spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
}

describe('an install never destroys the machine\'s epam command', () => {
  it('still installs a working shim — the feature is intact', () => {
    const root = tmp('inst-'); const bin = tmp('bin-');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/epam.js'), 'console.log("epam ok");');
    runShimBlock({ root, binDir: bin });
    expect(existsSync(join(bin, 'epam')), 'no shim written').toBe(true);
    const r = spawnSync('bash', [join(bin, 'epam')], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout.trim(), `shim did not run: ${r.stderr}`).toBe('epam ok');
  });

  it('backs up a shim that points at a DIFFERENT install before replacing it', () => {
    const bin = tmp('bin-');
    const oldRoot = tmp('old-');
    mkdirSync(join(oldRoot, 'dist'), { recursive: true });
    writeFileSync(join(oldRoot, 'dist/epam.js'), 'console.log("the original");');
    writeFileSync(join(bin, 'epam'),
      `#!/usr/bin/env bash\nexec node "${oldRoot}/dist/epam.js" "$@"\n`);
    chmodSync(join(bin, 'epam'), 0o755);

    const newRoot = tmp('new-');
    mkdirSync(join(newRoot, 'dist'), { recursive: true });
    writeFileSync(join(newRoot, 'dist/epam.js'), 'console.log("the takeover");');
    runShimBlock({ root: newRoot, binDir: bin });

    const backups = readdirSync(bin).filter((f) => f !== 'epam' && f.startsWith('epam'));
    expect(backups.length, `the previous command was destroyed with no backup: ${readdirSync(bin).join(', ')}`)
      .toBeGreaterThan(0);
    expect(readFileSync(join(bin, backups[0]), 'utf8'),
      'the backup does not contain the shim it replaced').toContain(oldRoot);
  });

  it('does not pile up a backup when the shim already points at this same install', () => {
    const root = tmp('inst-'); const bin = tmp('bin-');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/epam.js'), 'console.log("epam ok");');
    runShimBlock({ root, binDir: bin });
    runShimBlock({ root, binDir: bin });
    const backups = readdirSync(bin).filter((f) => f !== 'epam');
    expect(backups, `re-installing the same tree littered backups: ${backups.join(', ')}`).toEqual([]);
  });

  it('a shim whose install has vanished says so, instead of a node stack trace', () => {
    const root = tmp('inst-'); const bin = tmp('bin-');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/epam.js'), 'console.log("epam ok");');
    runShimBlock({ root, binDir: bin });
    rmSync(root, { recursive: true, force: true });

    const r = spawnSync('bash', [join(bin, 'epam')], { encoding: 'utf8', timeout: 30_000 });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    expect(out, 'the broken shim did not name the install that vanished').toContain(root);
    expect(/Cannot find module/.test(out),
      `it still fails as a raw node module error: ${out.slice(0, 200)}`).toBe(false);
    expect(r.status, 'a broken command must not report success').not.toBe(0);
  });
});
