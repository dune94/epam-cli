/**
 * THE LAUNCHER CHECKS THE PROGRAM A RUNNER DECLARES — NOT THE RUNNER'S NAME.
 *
 * Live 2026-09-30 (AMSD-2974, codemie-web): `pipeline --jira` refused to start — "the 'codemie-web'
 * stack runs 'codemie-web', which is not on PATH". codemie-web's runner is the pipeline's own plugin;
 * the program it needs is the one config/providers.json declares for it (cliBinary: the CodeMie CLI).
 * A runner whose program is a variable ($EPAM_CLI) is resolved at run time, not by PATH.
 *
 * EXECUTED: the real launcher, in dry run, with PATH controlled; every name read from the config.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PIPELINE = join(ROOT, 'orchestrations/scripts/pipeline');
const CONFIG = join(ROOT, 'orchestrations/config');
const sets = JSON.parse(readFileSync(join(CONFIG, 'provider-sets.json'), 'utf8')).sets;
const cliBinary = JSON.parse(readFileSync(join(CONFIG, 'providers.json'), 'utf8')).cliBinary || {};
const firstRunner = (set: string) => Object.keys(JSON.parse(readFileSync(join(CONFIG, sets[set].settingsFile), 'utf8')).runners || {})[0] || '';
// A set whose runner's declared program differs from the runner's own name, and is a real program.
const SET = Object.keys(sets).find((s) => { const r = firstRunner(s); const b = cliBinary[r]; return r && b && b !== r && !b.startsWith('$'); }) as string;
const RUNNER = firstRunner(SET);
const PROGRAM = cliBinary[RUNNER];
// A ticket prefix some project declares, so the dry run reaches the checks.
const PREFIX = readdirSync(join(ROOT, 'orchestrations/projects')).map((p) => {
  try { return (/^JIRA_PROJECT_KEY=(\S+)/m.exec(readFileSync(join(ROOT, 'orchestrations/projects', p, 'config.env'), 'utf8')) || [])[1]; } catch { return ''; }
}).find(Boolean) as string;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function launch(withProgram: boolean) {
  const bin = mkdtempSync(join(tmpdir(), 'launcher-path-')); dirs.push(bin);
  if (withProgram) { writeFileSync(join(bin, PROGRAM), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, PROGRAM), 0o755); }
  // The host's own PATH, minus the program under test: every tool it offers, first match wins, linked
  // into one directory — except the program (the host may have its own copy, beside node or jq).
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const d of (process.env.PATH || '').split(':')) {
    let tools: string[] = []; try { tools = readdirSync(d); } catch { continue; }
    for (const t of tools) if (t !== PROGRAM && !existsSync(join(bin, t))) { try { symlinkSync(join(d, t), join(bin, t)); } catch { /* raced */ } }
  }
  const path = bin;
  return spawnSync('bash', [PIPELINE, '--jira', `${PREFIX}-1`, '--dry-run'], { cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PATH: path, EPAM_PROVIDER_SET: SET, NODE_BIN: process.execPath } });
}

describe('the launcher checks the program a runner declares', () => {
  it('the config offers a runner whose program is not its own name (or this proves nothing)', () => {
    expect(SET, 'no set runs a program named differently from its runner').toBeTruthy();
    expect(PREFIX).toBeTruthy();
  });

  it('with that program on PATH, the launcher does not complain about the runner', () => {
    const r = launch(true);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/not on PATH/);
  });

  it('without it, the complaint names the PROGRAM the runner declares', () => {
    const out = (() => { const r = launch(false); return `${r.stdout}${r.stderr}`; })();
    expect(out).toMatch(new RegExp(`'${PROGRAM}'[^\\n]*not on PATH`));
  });
});
