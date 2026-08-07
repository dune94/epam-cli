/**
 * A PROJECT'S PLUGINS MUST SURVIVE THE GATE'S ALLOWLIST.
 *
 * The project registers plugins in EPAM_PROJECT_CONFIG_DIR/plugins.json; the orchestrator
 * provisions them into each worktree's .epam/settings.json; createTools() loads them. Then
 * four seams applied `EPAM_ALLOWED_TOOLS="bash,read_file,list_files,search"`, and
 * applyToolAllowlist() filters by NAME — so every project plugin tool was structurally
 * removed before the model saw it. Metrolinx registers two plugins today and the gates were
 * handed none of their tools.
 *
 * The allowlist is also a real safety boundary: it is what stops a reviewer rewriting the
 * code it is judging. So this widens it to the project's own read-only plugins and NOT to
 * write_file.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/gate-tools.sh');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
const PLUGINS = join(__dirname, '../../../orchestrations/plugins');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function allowed(settings?: { tools: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-')); dirs.push(dir);
  if (settings) {
    mkdirSync(join(dir, '.epam'), { recursive: true });
    writeFileSync(join(dir, '.epam', 'settings.json'), JSON.stringify(settings));
  }
  const res = spawnSync('bash', ['-c',
    `export EPAM_NODE_BIN=${JSON.stringify(NODE)}; ` +
    `source ${JSON.stringify(LIB)}; gate_allowed_tools ${JSON.stringify(dir)}`,
  ], { encoding: 'utf8' });
  return ((res.stdout || '') + '').trim();
}

const BASE = ['bash', 'read_file', 'list_files', 'search'];

describe('the base set is intact', () => {
  it('with no plugins registered, the gate keeps exactly its previous capability', () => {
    const out = allowed();
    expect(out.split(',').filter(Boolean).sort()).toEqual([...BASE].sort());
  });

  it('an unreadable registration does not blank the allowlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-bad-')); dirs.push(dir);
    mkdirSync(join(dir, '.epam'), { recursive: true });
    writeFileSync(join(dir, '.epam', 'settings.json'), 'not json at all');
    const res = spawnSync('bash', ['-c',
      `export EPAM_NODE_BIN=${JSON.stringify(NODE)}; ` +
      `source ${JSON.stringify(LIB)}; gate_allowed_tools ${JSON.stringify(dir)}`,
    ], { encoding: 'utf8' });
    for (const t of BASE) expect((res.stdout || '').trim()).toContain(t);
  });
});

describe('registered plugin tools are admitted', () => {
  const out = () => allowed({ tools: [join(PLUGINS, 'dependency-contract-tools.js')] });

  it('THE GAP: the project plugin\'s tools reach the gate', () => {
    expect(
      out(),
      'the project registered this plugin and the gate filtered every one of its tools out',
    ).toContain('dependency_available');
    expect(out()).toContain('dependency_contract');
  });

  it('the base set still comes through alongside them', () => {
    for (const t of BASE) expect(out()).toContain(t);
  });

  it('a second plugin contributes too', () => {
    const both = allowed({ tools: [
      join(PLUGINS, 'dependency-contract-tools.js'),
      join(PLUGINS, 'codeline-context-tools.js'),
    ] });
    expect(both).toContain('dependency_available');
    expect(both).toContain('codeline_facts');
  });

  it('a plugin that cannot load does not take the others down', () => {
    const out2 = allowed({ tools: [
      '/nonexistent/plugin.js',
      join(PLUGINS, 'dependency-contract-tools.js'),
    ] });
    expect(out2).toContain('dependency_available');
    for (const t of BASE) expect(out2).toContain(t);
  });
});

describe('the read-only boundary is not widened', () => {
  it('write_file is never admitted — it is what stops a reviewer rewriting what it judges', () => {
    const out2 = allowed({ tools: [
      join(PLUGINS, 'dependency-contract-tools.js'),
      join(PLUGINS, 'codeline-context-tools.js'),
    ] });
    expect(out2).not.toContain('write_file');
  });
});
