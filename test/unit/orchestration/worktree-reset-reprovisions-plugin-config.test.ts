/**
 * _selective_worktree_reset — plugin config re-provisioning after a real
 * reset. Added 2026-08-02.
 *
 * Root cause: .epam/settings.json and .epam/codeline-facts.json (the
 * Metrolinx codeline-context plugin's wiring — see
 * orchestrations/plugins/codeline-context-plugin.js) are UNTRACKED, so a
 * lane's first hard reset (`git clean -fd`) silently wiped them, with
 * nothing re-provisioning them afterward. Found live in a Writer Retest run:
 * confirmed via `.epam/settings.json` present on the one lane that never hit
 * a reset, absent on the two that did. Every subsequent attempt on a reset
 * lane silently lost the plugin for the rest of the story.
 *
 * Real git repos throughout, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const GIT_OPS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const gitOpsSrc = readFileSync(GIT_OPS_SH, 'utf8');

function extractFunctionBody(src: string, name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(src);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}
// _selective_worktree_reset (claude.sh) now calls the shared
// _provision_epam_plugin_config() helper (2026-08-02 git-ops consolidation —
// the same function ensure_story_branch()'s own working-tree reset uses) —
// both must be present in the standalone harness script below.
const FN_BODY = [
  extractFunctionBody(gitOpsSrc, '_provision_epam_plugin_config'),
  extractFunctionBody(claudeSrc, '_selective_worktree_reset'),
].join('\n');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'worktree-reset-reprov-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  writeFileSync(join(seed, 'src/tracked.ts'), 'export const original = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

  return { clone };
}

function runReset(opts: {
  projectRoot: string;
  configDir: string | null;
  prdPath: string | null;
}): string {
  const scriptPath = join(opts.projectRoot, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(opts.projectRoot)}`,
      'EPAM_BROWNFIELD=1',
      'JIRA_BASELINE_BRANCH=develop',
      opts.configDir ? `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(opts.configDir)}` : '',
      opts.prdPath ? `PRD_FILE=${JSON.stringify(opts.prdPath)}` : '',
      'log() { echo "LOG: $*" >&2; }',
      'LAST_ATTEMPT_TSC_PASSED=false',
      'LAST_VERIFIED_TOUCHED_FILES="src/tracked.ts"',
      'LAST_VERIFIED_UNCHANGED_FILES=""',
      FN_BODY,
      '_selective_worktree_reset "SKY-TEST"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return (result.stdout || '') + (result.stderr || '');
}

describe('_selective_worktree_reset — re-provisions plugin config after a real reset', () => {
  it('re-copies plugins.json into .epam/settings.json after the reset wipes it', () => {
    const { clone } = makeFixture();
    mkdirSync(join(clone, '.epam'), { recursive: true });
    writeFileSync(join(clone, '.epam/settings.json'), JSON.stringify({ tools: ['/abs/plugin.js'] }));

    const configDir = mkdtempSync(join(tmpdir(), 'worktree-reset-cfg-'));
    cleanupDirs.push(configDir);
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: ['/abs/plugin.js'] }));

    runReset({ projectRoot: clone, configDir, prdPath: null });

    const settingsPath = join(clone, '.epam/settings.json');
    expect(existsSync(settingsPath), 'settings.json was not re-provisioned after the reset').toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ tools: ['/abs/plugin.js'] });
  });

  it("re-extracts THIS codeline's facts entry into .epam/codeline-facts.json, by matching PROJECT_ROOT against the PRD's outputDirs", () => {
    const { clone } = makeFixture();
    const configDir = mkdtempSync(join(tmpdir(), 'worktree-reset-cfg-'));
    cleanupDirs.push(configDir);
    writeFileSync(
      join(configDir, 'codeline-facts.json'),
      JSON.stringify({
        gotransit: { facts: ['gotransit fact'] },
        upexpress: { facts: ['upexpress fact — must NOT leak'] },
      }),
    );
    const prdPath = join(configDir, 'prd.json');
    writeFileSync(
      prdPath,
      JSON.stringify({ project: { outputDirs: [{ codeline: 'gotransit', path: clone }] } }),
    );

    runReset({ projectRoot: clone, configDir, prdPath });

    const factsPath = join(clone, '.epam/codeline-facts.json');
    expect(existsSync(factsPath), 'codeline-facts.json was not re-provisioned').toBe(true);
    const written = JSON.parse(readFileSync(factsPath, 'utf8'));
    expect(written).toEqual({ facts: ['gotransit fact'] });
    expect(JSON.stringify(written)).not.toContain('upexpress fact');
  });

  it('is a silent no-op when EPAM_PROJECT_CONFIG_DIR is unset (most projects have no plugin config)', () => {
    const { clone } = makeFixture();
    const out = runReset({ projectRoot: clone, configDir: null, prdPath: null });
    expect(out).not.toMatch(/Provisioned|reprovision/i);
    expect(existsSync(join(clone, '.epam/settings.json'))).toBe(false);
  });

  it('does not re-provision when the reset itself was skipped (a fix site changed, nothing wiped)', () => {
    const { clone } = makeFixture();
    mkdirSync(join(clone, '.epam'), { recursive: true });
    writeFileSync(join(clone, '.epam/settings.json'), JSON.stringify({ tools: ['/abs/original.js'] }));
    writeFileSync(join(clone, '..', 'prd.json'), JSON.stringify({
      stories: [{ id: 'SKY-TEST', fixSiteAnalysis: [{ file: 'src/tracked.ts', fixVerified: true }] }],
    }));
    writeFileSync(join(clone, 'src/tracked.ts'), 'export const original = 1;\nexport const realFix = true;\n');
    const configDir = mkdtempSync(join(tmpdir(), 'worktree-reset-cfg-'));
    cleanupDirs.push(configDir);
    // A DIFFERENT plugins.json than what's already there — if re-provisioning
    // ran even on a skipped reset, this would overwrite the original.
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: ['/abs/different.js'] }));

    const scriptPath = join(clone, '..', 'run.sh');
    writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        `PROJECT_ROOT=${JSON.stringify(clone)}`,
        'EPAM_BROWNFIELD=1',
        'JIRA_BASELINE_BRANCH=develop',
        `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(configDir)}`,
        'log() { echo "LOG: $*" >&2; }',
        // A VERIFIED fix site changed -> the reset is skipped entirely, so .epam is untouched.
        // (Was 'LAST_ATTEMPT_TSC_PASSED=true' — the compiler no longer decides this.)
        `MAIN_PRD_FILE=${JSON.stringify(join(clone, '..', 'prd.json'))}`,
        FN_BODY,
        '_selective_worktree_reset "SKY-TEST"',
      ].join('\n'),
    );
    spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });

    expect(JSON.parse(readFileSync(join(clone, '.epam/settings.json'), 'utf8'))).toEqual({
      tools: ['/abs/original.js'],
    });
  });
});
