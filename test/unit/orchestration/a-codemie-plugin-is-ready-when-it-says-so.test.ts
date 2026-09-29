/**
 * A CODEMIE PLUGIN IS READY WHEN IT SAYS SO — BY A FILE, NOT BY THE WORDING OF ITS LOG.
 *
 * plugins.js decided a plugin was connected when its log matched /connected \d+ tools|ready to serve
 * \d+ tools/ and refused when it matched /Authorization Violation|NATS error/ — the library's console
 * prose, which any codemie-plugins release may reword (review of 2026-09-29, item 2). The plugin host
 * now writes a ready file at the library's own success point (its plugin-engine subjects subscribed),
 * or a failed file naming the exception type; plugins.js waits on those and on the process, and the
 * log is only where a person is sent to read more.
 *
 * Executed: the real ensurePlugin, with a stand-in interpreter in the declared venv
 * (EPAM_CODEMIE_PLUGINS_VENV) that does one thing each case — so what is judged is plugins.js's
 * reading, not a plugin's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const PLUGINS = join(ROOT, 'orchestrations/plugins/providers/codemie-web/plugins.js');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    spawnSync(process.execPath, [PLUGINS, 'stop-all'], { env: { ...process.env, EPAM_CODEMIE_WEB_HOME: join(d, 'home') } });
    rmSync(d, { recursive: true, force: true });
  }
});

/** A venv whose python runs `body` (bash) with the host's argv: $1 mode, $2 root, $3 ready file. */
function venvWith(body: string) {
  const d = mkdtempSync(join(tmpdir(), 'plugin-ready-')); dirs.push(d);
  mkdirSync(join(d, 'venv/bin'), { recursive: true });
  const py = join(d, 'venv/bin/python');
  writeFileSync(py, `#!/usr/bin/env bash\nshift  # the host script\n${body}\n`); chmodSync(py, 0o755);
  mkdirSync(join(d, 'root'));
  return d;
}

function ensure(d: string, mode = 'ro') {
  const r = spawnSync(process.execPath, ['-e', `
    const { ensurePlugin } = require(${JSON.stringify(PLUGINS)});
    const c = { integrations: { list: async () => [{ alias: 'Pipeline cl ${mode}', id: 'i1' }], create: async () => {} }, users: { aboutMe: async () => ({ username: 'u' }) } };
    ensurePlugin(c, { codeline: 'cl', mode: ${JSON.stringify(mode)}, root: ${JSON.stringify(join(d, 'root'))} })
      .then((i) => { console.log('READY', i.id); }, (e) => { console.log('REFUSED', e.message); });
  `], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, EPAM_CODEMIE_WEB_HOME: join(d, 'home'), EPAM_CODEMIE_PLUGINS_VENV: join(d, 'venv'), EPAM_CODEMIE_PLUGIN_CONNECT_MS: '4000' } });
  return r.stdout.trim();
}

describe('plugins.js waits on the plugin\'s own signal', () => {
  it('a ready file is ready — though the log says nothing at all', () => {
    const d = venvWith('echo \'{"tools":4}\' > "$3"; exec sleep 30');
    expect(ensure(d)).toBe('READY i1');
  });

  it('a log that SAYS ready is not ready without the file — it times out', () => {
    const d = venvWith('echo "Subscribed to NATS subjects, ready to serve 4 tools"; echo "connected 4 tools"; exec sleep 30');
    expect(ensure(d)).toMatch(/^REFUSED .*did not (connect|signal ready)/);
  });

  it('a failed file refuses at once, naming what the host reported', () => {
    const d = venvWith('echo \'{"error":"AuthorizationError"}\' > "$3.failed"; exec sleep 30');
    const out = ensure(d);
    expect(out).toMatch(/^REFUSED .*AuthorizationError/);
  });

  it('a log that SAYS refused, with a live process and a ready file, is ready', () => {
    const d = venvWith('echo "nats: Authorization Violation"; echo "NATS error"; echo \'{"tools":4}\' > "$3"; exec sleep 30');
    expect(ensure(d)).toBe('READY i1');
  });

  it('a process that exits before signalling is refused, pointing at its log', () => {
    const d = venvWith('echo boom; exit 3');
    expect(ensure(d)).toMatch(/^REFUSED .*exited.*\.log/);
  });

  it('both modes start through the host: the interpreter is told the mode, the root and where to signal', () => {
    for (const mode of ['ro', 'rw']) {
      const d = venvWith('printf "%s\\n" "$@" > "$2/argv.txt"; echo \'{"tools":1}\' > "$3"; exec sleep 30');
      expect(ensure(d, mode)).toBe('READY i1');
      const argv = readFileSync(join(d, 'root/argv.txt'), 'utf8').trim().split('\n');
      expect(argv[0]).toBe(mode);
      expect(existsSync(argv[1])).toBe(true);
      expect(argv[2]).toMatch(/\.ready$/);
    }
  });
});
