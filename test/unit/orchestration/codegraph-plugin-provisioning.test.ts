/**
 * CodeGraph query tool (orchestrations/plugins/codegraph-tools.js) —
 * provisioned as a first-class, built-in plugin for EVERY codeline
 * unconditionally, merged with whatever project-specific plugins.json adds.
 *
 * Built 2026-08-02 after an assessment found CodeGraph was only reachable
 * through a shell script the model had to invoke via the generic Bash tool
 * — real output-token cost on every one of the 5-10 iterative calls a real
 * investigation makes (reconstructing a full `PROJECT_ROOT=... bash
 * .../codegraph-agent-query.sh <subcommand> <args>` command line each
 * time), plus Bash's own approval/classification overhead for what is, in
 * truth, a read-only code-introspection query. This test proves the
 * PROVISIONING side: the built-in plugin is written into every codeline's
 * .epam/settings.json regardless of whether that project configured ANY
 * plugins.json of its own, merged (not overwritten) with project-specific
 * tools when they do exist.
 *
 * Real files, real jq, no mocking — SCRIPT_DIR points at the real repo so
 * the real codegraph-tools.js path is resolved, matching production.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_DIR = join(REPO_ROOT, 'orchestrations/scripts');
const GIT_OPS_SH = join(SCRIPT_DIR, 'lib/git-ops.sh');
const CODEGRAPH_PLUGIN = join(REPO_ROOT, 'orchestrations/plugins/codegraph-tools.js');
const gitOpsSrc = readFileSync(GIT_OPS_SH, 'utf8');

function extractFn(name: string): string {
  const start = gitOpsSrc.indexOf(`${name}() {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = gitOpsSrc.indexOf('\n}', start) + 2;
  return gitOpsSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runProvision(projectRoot: string, configDir: string | null): { stdout: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-provision-run-'));
  cleanupDirs.push(dir);
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `SCRIPT_DIR=${JSON.stringify(SCRIPT_DIR)}`,
      configDir ? `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(configDir)}` : '',
      extractFn('_provision_epam_plugin_config'),
      `_provision_epam_plugin_config ${JSON.stringify(projectRoot)}`,
      'echo "EXIT_MARKER:$?"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const combined = (result.stdout || '') + (result.stderr || '');
  const m = combined.match(/EXIT_MARKER:(\d+)/);
  return { stdout: combined, exitCode: m ? parseInt(m[1], 10) : (result.status ?? -1) };
}

describe('_provision_epam_plugin_config — built-in CodeGraph plugin provisioning', () => {
  it('the real codegraph-tools.js plugin file exists at the path production code expects', () => {
    expect(existsSync(CODEGRAPH_PLUGIN)).toBe(true);
  });

  it('provisions the built-in CodeGraph tool even when NO project config exists at all', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'codegraph-provision-proj-'));
    cleanupDirs.push(projectRoot);

    const { exitCode } = runProvision(projectRoot, null);
    expect(exitCode).toBe(0);

    const settingsPath = join(projectRoot, '.epam/settings.json');
    expect(existsSync(settingsPath), 'settings.json was not provisioned for a project with no config at all').toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.tools).toEqual([CODEGRAPH_PLUGIN]);
  });

  it('merges the built-in CodeGraph tool WITH a project-specific plugins.json, rather than overwriting it', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'codegraph-provision-proj-'));
    cleanupDirs.push(projectRoot);
    const configDir = mkdtempSync(join(tmpdir(), 'codegraph-provision-cfg-'));
    cleanupDirs.push(configDir);
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: ['/abs/project-specific-tool.js'] }));

    const { exitCode } = runProvision(projectRoot, configDir);
    expect(exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(join(projectRoot, '.epam/settings.json'), 'utf8'));
    expect(settings.tools).toEqual(expect.arrayContaining([CODEGRAPH_PLUGIN, '/abs/project-specific-tool.js']));
    expect(settings.tools).toHaveLength(2);
  });

  it('does not duplicate the CodeGraph entry if a project happens to list it too', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'codegraph-provision-proj-'));
    cleanupDirs.push(projectRoot);
    const configDir = mkdtempSync(join(tmpdir(), 'codegraph-provision-cfg-'));
    cleanupDirs.push(configDir);
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: [CODEGRAPH_PLUGIN] }));

    runProvision(projectRoot, configDir);

    const settings = JSON.parse(readFileSync(join(projectRoot, '.epam/settings.json'), 'utf8'));
    expect(settings.tools).toEqual([CODEGRAPH_PLUGIN]);
  });
});

describe('codegraph-tools.js — the plugin module itself', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const plugin = require(CODEGRAPH_PLUGIN);

  it('exports exactly one tool: codegraph_query', () => {
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools[0].name).toBe('codegraph_query');
  });

  it('declares pluginApiVersion and permission:"safe" (no approval-required Bash routing)', () => {
    const tool = plugin.tools[0];
    expect(tool.pluginApiVersion).toBe('1.0.0');
    expect(tool.permission).toBe('safe');
  });

  it('rejects an invalid mode without shelling out', async () => {
    const tool = plugin.tools[0];
    const result = await tool.execute({ mode: 'not-a-real-mode', args: 'foo' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/mode must be one of/);
  });

  it('rejects empty args', async () => {
    const tool = plugin.tools[0];
    const result = await tool.execute({ mode: 'explore', args: '' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/args is required/);
  });

  it('really runs codegraph-agent-query.sh for a valid call, against a real temp repo', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'codegraph-plugin-exec-'));
    cleanupDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/example.ts'), 'export function parseThing(x: string) { return x; }\n');

    if (!(spawnSync('which', ['codegraph']).status === 0)) {
      // codegraph binary not installed in this environment — skip rather than false-fail.
      return;
    }
    const tool = plugin.tools[0];
    const cwd = process.cwd();
    try {
      process.chdir(projectRoot);
      const result = await tool.execute({ mode: 'helpers', args: 'parse' });
      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      process.chdir(cwd);
    }
  }, 30000);
});
