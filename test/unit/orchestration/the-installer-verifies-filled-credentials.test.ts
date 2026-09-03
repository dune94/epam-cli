import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A COPIED-BUT-UNFILLED .env REPORTED "PRESENT" AND NOTHING MORE.
 *
 * Same defect class already fixed for dist/epam.js ("EXISTENCE IS NOT A BUILD, either way"): the
 * old Credentials check was `[ -f "$ROOT/.env" ]` — a file that exists but still holds the
 * template's empty placeholders passes it, and a stack's own REQUIRED credential (openrouter needs
 * OPENROUTER_API_KEY and MINIMAX_API_KEY, declared in provider-sets.json) could sit empty all the
 * way to the first paid call before anyone noticed.
 *
 * These tests EXECUTE install.sh against a fixture that ships the real set-credentials.sh (the
 * shared resolver the pipeline itself uses) so the check under test is the real one, not a
 * reimplementation of it.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER = path.join(REPO, 'orchestrations-installer/install.sh');

function fixture(opts: { openrouterKey?: string; minimaxKey?: string; stack?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-creds-'));
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations/scripts/lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(dir, 'orchestrations-installer/install.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/install.sh'), 0o755);
  for (const f of ['container-runtime.sh', 'wait-for-health.sh', 'isolated-compose-identity.sh', 'generate-env-example.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  // THE REAL RESOLVER — this is what makes the test prove something about install.sh's actual
  // check, rather than a hand-copied stand-in that could silently drift from it.
  fs.copyFileSync(path.join(REPO, 'orchestrations/scripts/lib/set-credentials.sh'),
    path.join(dir, 'orchestrations/scripts/lib/set-credentials.sh'));

  fs.writeFileSync(path.join(dir, 'orchestrations/config/provider-sets.json'), JSON.stringify({
    defaultSet: 'openrouter',
    sets: {
      openrouter: {
        settingsFile: 'llm-defaults.openrouter.json',
        credentials: [
          { env: 'EPAM_API_KEY_OPENROUTER', from: 'OPENROUTER_API_KEY', required: true },
          { env: 'EPAM_API_KEY_MINIMAX', from: 'MINIMAX_API_KEY', required: true },
        ],
      },
      claude: { settingsFile: 'llm-defaults.claude.json', credentials: [] },
    },
  }));
  for (const f of ['llm-defaults.openrouter.json', 'llm-defaults.claude.json']) {
    fs.writeFileSync(path.join(dir, 'orchestrations/config', f), JSON.stringify({ runners: { claude: {} } }));
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));

  const env: string[] = [];
  if (opts.openrouterKey !== undefined) env.push(`OPENROUTER_API_KEY=${opts.openrouterKey}`);
  if (opts.minimaxKey !== undefined) env.push(`MINIMAX_API_KEY=${opts.minimaxKey}`);
  fs.writeFileSync(path.join(dir, '.env'), env.join('\n') + (env.length ? '\n' : ''));

  return dir;
}

const run = (dir: string, stack: string) =>
  spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'), '--no-docker', '--stack', stack],
    { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, EPAM_NONINTERACTIVE: '1' } });

describe('the installer verifies required credentials are actually filled in', () => {
  it('FAILS when a required credential is present in .env as an empty placeholder', () => {
    const dir = fixture({ openrouterKey: '', minimaxKey: '' });
    const r = run(dir, 'openrouter');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, `an unfilled required credential must fail the install:\n${out.slice(-800)}`).not.toBe(0);
    expect(out).toMatch(/OPENROUTER_API_KEY/);
    expect(out).toMatch(/MINIMAX_API_KEY/);
  });

  it('FAILS when a required credential is missing from .env entirely', () => {
    const dir = fixture({ openrouterKey: 'sk-real-key' }); // minimax never written at all
    const r = run(dir, 'openrouter');
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/MINIMAX_API_KEY/);
  });

  it('PASSES when every required credential for the active stack is filled in', () => {
    const dir = fixture({ openrouterKey: 'sk-real-key', minimaxKey: 'mm-real-key' });
    const r = run(dir, 'openrouter');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, `install failed with real credentials present:\n${out.slice(-800)}`).toBe(0);
    expect(out).toMatch(/required 'openrouter' credentials are filled in/);
  });

  it('never asks for a credential the ACTIVE stack does not declare', () => {
    // claude declares no credentials at all — an install on the claude stack must not demand
    // openrouter's OPENROUTER_API_KEY/MINIMAX_API_KEY just because that set exists in the file.
    const dir = fixture({}); // no keys anywhere
    const r = run(dir, 'claude');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, `claude needs no credentials, must not fail on openrouter's:\n${out.slice(-800)}`).toBe(0);
    expect(out).not.toMatch(/OPENROUTER_API_KEY|MINIMAX_API_KEY/);
  });

  it('regenerates .env.example so it actually names the active stack\'s real required vars', () => {
    const dir = fixture({ openrouterKey: 'x', minimaxKey: 'y' });
    run(dir, 'openrouter');
    const tpl = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    expect(tpl, '.env.example was never (re)generated').toMatch(/OPENROUTER_API_KEY=/);
    expect(tpl).toMatch(/MINIMAX_API_KEY=/);
    expect(tpl).toMatch(/openrouter/);
  });
});
