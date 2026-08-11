/**
 * Plugin provisioning wiring (run-agent-orchestration.sh, inside _run_codeline_loop) —
 * config-driven, zero project-specific hardcoding. Added 2026-08-01 alongside the
 * Metrolinx codeline-context plugin: EPAM_PROJECT_CONFIG_DIR/plugins.json is copied
 * verbatim into a codeline's .epam/settings.json, and codeline-facts.json's entry
 * for THIS codeline is extracted into .epam/codeline-facts.json. This script has no
 * idea what a "plugin" is — adding/removing one is purely a config edit in the
 * project directory, never a change here.
 *
 * Real files, real jq, no mocking. Extracts the exact snippet from the real script
 * so this tracks the real code, not a reimplementation of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractSnippet(): string {
  const start = orchSrc.indexOf('# ── Plugin provisioning: config-driven');
  if (start === -1) throw new Error('plugin provisioning snippet not found in run-agent-orchestration.sh');
  const end = orchSrc.indexOf('\n  done', start);
  if (end === -1) throw new Error('end marker not found');
  return orchSrc.slice(start, end);
}

const SNIPPET = extractSnippet();

function extractFunctionBody(name: string): string {
  const start = orchSrc.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in run-agent-orchestration.sh`);
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}
const PROVISION_ENV_LOCAL_FN = extractFunctionBody('provision_env_local_from_sample');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runSnippet(cl: string, wt: string, configDir: string | null): string {
  const scriptPath = join(wt, '..', 'run.sh');
  // The real snippet uses `local`, which is only valid inside a function (it
  // runs for real inside _run_codeline_loop()) — wrap it the same way here.
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      configDir ? `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(configDir)}` : '',
      'log() { echo "LOG: $*"; }',
      PROVISION_ENV_LOCAL_FN,
      'run_snippet() {',
      `  local _cl=${JSON.stringify(cl)}`,
      `  local _wt=${JSON.stringify(wt)}`,
      SNIPPET,
      '}',
      'run_snippet',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return (result.stdout || '') + (result.stderr || '');
}

function makeFixture(): { root: string; wt: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'plugin-wiring-'));
  cleanupDirs.push(root);
  const wt = join(root, 'codeline');
  mkdirSync(wt, { recursive: true });
  const configDir = join(root, 'project-config');
  mkdirSync(configDir, { recursive: true });
  return { root, wt, configDir };
}

describe('plugin provisioning wiring — plugins.json', () => {
  it('copies plugins.json verbatim into the worktree .epam/settings.json', () => {
    const { wt, configDir } = makeFixture();
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: ['/abs/path/tool.js'] }));

    const out = runSnippet('gotransit', wt, configDir);

    const settingsPath = join(wt, '.epam/settings.json');
    expect(existsSync(settingsPath), 'settings.json was not written').toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ tools: ['/abs/path/tool.js'] });
    expect(out).toContain("Provisioned .epam/settings.json (plugins, incl. built-in CodeGraph tool) for 'gotransit'");
  });

  it('is a silent no-op when plugins.json does not exist', () => {
    const { wt, configDir } = makeFixture();

    const out = runSnippet('gotransit', wt, configDir);

    expect(existsSync(join(wt, '.epam/settings.json'))).toBe(false);
    expect(out).not.toContain('Provisioned .epam/settings.json');
  });

  it('is a silent no-op when EPAM_PROJECT_CONFIG_DIR is unset', () => {
    const { wt } = makeFixture();
    const out = runSnippet('gotransit', wt, null);
    expect(existsSync(join(wt, '.epam/settings.json'))).toBe(false);
    expect(out).not.toContain('Provisioned');
  });
});

describe('plugin provisioning wiring — codeline-facts.json', () => {
  it("extracts only THIS codeline's facts entry, keyed by codeline name", () => {
    const { wt, configDir } = makeFixture();
    writeFileSync(
      join(configDir, 'codeline-facts.json'),
      JSON.stringify({
        gotransit: { facts: ['gotransit-specific fact'] },
        upexpress: { facts: ['upexpress-specific fact — must NOT leak into gotransit'] },
      }),
    );

    const out = runSnippet('gotransit', wt, configDir);

    const factsPath = join(wt, '.epam/codeline-facts.json');
    expect(existsSync(factsPath)).toBe(true);
    const written = JSON.parse(readFileSync(factsPath, 'utf8'));
    expect(written).toEqual({ facts: ['gotransit-specific fact'] });
    expect(JSON.stringify(written)).not.toContain('upexpress-specific');
    expect(out).toContain("Provisioned .epam/codeline-facts.json for 'gotransit'");
  });

  it('is a silent no-op when the codeline has no entry in codeline-facts.json', () => {
    const { wt, configDir } = makeFixture();
    writeFileSync(
      join(configDir, 'codeline-facts.json'),
      JSON.stringify({ upexpress: { facts: ['only upexpress configured'] } }),
    );

    const out = runSnippet('gotransit', wt, configDir);

    expect(existsSync(join(wt, '.epam/codeline-facts.json'))).toBe(false);
    expect(out).not.toContain('Provisioned .epam/codeline-facts.json');
  });

  it('is a silent no-op when codeline-facts.json does not exist', () => {
    const { wt, configDir } = makeFixture();
    const out = runSnippet('gotransit', wt, configDir);
    expect(existsSync(join(wt, '.epam/codeline-facts.json'))).toBe(false);
    expect(out).not.toContain('Provisioned .epam/codeline-facts.json');
  });
});

describe('plugin provisioning wiring — both files together, per real Metrolinx shape', () => {
  it('provisions settings.json AND codeline-facts.json in one pass for 3 codelines independently', () => {
    const { configDir } = makeFixture();
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: ['/abs/codeline-context-plugin.js'] }));
    writeFileSync(
      join(configDir, 'codeline-facts.json'),
      JSON.stringify({
        gotransit: { facts: ['fact-a'] },
        upexpress: { facts: ['fact-b'] },
        metrolinx: { facts: ['fact-c'] },
      }),
    );

    for (const [cl, expectedFact] of [
      ['gotransit', 'fact-a'],
      ['upexpress', 'fact-b'],
      ['metrolinx', 'fact-c'],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `plugin-wiring-${cl}-`));
      cleanupDirs.push(root);
      const wt = join(root, 'codeline');
      mkdirSync(wt, { recursive: true });

      runSnippet(cl, wt, configDir);

      expect(JSON.parse(readFileSync(join(wt, '.epam/settings.json'), 'utf8'))).toEqual({
        tools: ['/abs/codeline-context-plugin.js'],
      });
      expect(JSON.parse(readFileSync(join(wt, '.epam/codeline-facts.json'), 'utf8'))).toEqual({
        facts: [expectedFact],
      });
    }
  });
});

/**
 * env-vars.json (a hand-maintained, git-committed, per-codeline list) was removed
 * 2026-08-05: it hard-picked CONTENTSTACK_* keys on 2026-08-02 by trial and error, never
 * had MANAGEMENT_TOKEN, and nothing kept it in sync as the client codeline's own
 * requirements changed. .env.local is now DERIVED from the codeline's own
 * .env.local.sample — see provision_env_local_from_sample() and
 * env-local-from-sample.test.ts for the derivation logic itself. This block only proves
 * the WIRING: the codeline-provisioning snippet actually calls it, at the right point.
 */
describe('plugin provisioning wiring — .env.local (derived from the codeline\'s own sample)', () => {
  it('provisions .env.local from THIS codeline\'s own .env.local.sample', () => {
    const { wt, configDir } = makeFixture();
    writeFileSync(join(wt, '.env.local.sample'), 'CONTENTSTACK_API_KEY=\nCONTENTSTACK_BRANCH=main\n');

    const out = runSnippet('gotransit', wt, configDir);

    const envPath = join(wt, '.env.local');
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^CONTENTSTACK_API_KEY=\S+/m);
    expect(content).toMatch(/^CONTENTSTACK_BRANCH=\S+/m);
    expect(out).toContain("Provisioned .env.local for 'gotransit'");
  });

  it('is a silent no-op when the codeline has no .env.local.sample of its own', () => {
    const { wt, configDir } = makeFixture();

    const out = runSnippet('gotransit', wt, configDir);

    expect(existsSync(join(wt, '.env.local'))).toBe(false);
    expect(out).not.toContain('Provisioned .env.local');
  });
});

describe('plugin provisioning wiring — anti-patterns.json (feeds check_anti_patterns)', () => {
  it('copies anti-patterns.json verbatim into .epam/ (not keyed by codeline, unlike codeline-facts.json)', () => {
    const { wt, configDir } = makeFixture();
    const rules = JSON.stringify([{ id: 'example', matchPattern: 'foo', message: 'bar' }]);
    writeFileSync(join(configDir, 'anti-patterns.json'), rules);

    const out = runSnippet('gotransit', wt, configDir);

    const provisioned = join(wt, '.epam/anti-patterns.json');
    expect(existsSync(provisioned)).toBe(true);
    expect(readFileSync(provisioned, 'utf8')).toBe(rules);
    expect(out).toContain("Provisioned .epam/anti-patterns.json for 'gotransit'");
  });

  it('is a silent no-op when anti-patterns.json does not exist', () => {
    const { wt, configDir } = makeFixture();
    const out = runSnippet('gotransit', wt, configDir);
    expect(existsSync(join(wt, '.epam/anti-patterns.json'))).toBe(false);
    expect(out).not.toContain('Provisioned .epam/anti-patterns.json');
  });

  it('is a silent no-op when EPAM_PROJECT_CONFIG_DIR is unset', () => {
    const { wt } = makeFixture();
    const out = runSnippet('gotransit', wt, null);
    expect(existsSync(join(wt, '.epam/anti-patterns.json'))).toBe(false);
    expect(out).not.toContain('Provisioned .epam/anti-patterns.json');
  });
});
