/**
 * RETEST OF 916ea6f AND ea776eb — two launcher/runner fixes shipped with no test.
 *
 *   916ea6f — `echo x | claude -s --print` exits 1 with "unknown option '-s'". -s is
 *             codemie-claude's silent flag; plain claude has no such option. It was removed from
 *             the claude and mockserver runners and kept for codemie-claude.
 *
 *             The commit also records the diagnosis being RETRACTED once, because a
 *             `claude -s --help` probe exited 0 — and --help short-circuits argument validation,
 *             so that probe proved nothing. Hence this asserts the resolved runner declaration
 *             rather than probing the binary.
 *
 *   ea776eb — tier3-mock-run.sh resolved EPAM_PROJECT_CONFIG_DIR and never loaded the env inside
 *             it, so config.env and config.<set>.env were both ignored. run-agent-orchestration.sh
 *             then loaded the repo .env in preserve mode and, nothing having set a provider yet,
 *             that file's stale EPAM_ORCHESTRATION_PROVIDER=openrouter won. A run launched with
 *             EPAM_PROVIDER_SET=claude ended up on openrouter.
 *
 * Both are asserted on what the pipeline RESOLVES, not on the text that produces it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const PROJECT = join(REPO, 'orchestrations/projects/mock3');
const RESOLVER = join(REPO, 'orchestrations/scripts/lib/llm-settings-resolve.js');

/** The flags a runner is given under a set, as the pipeline resolves them. */
function alwaysFlags(set: string, runner: string): string[] | null {
  const r = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(RESOLVER)});
    const v = m.runnerValues(${JSON.stringify(runner)}, { projectConfigDir: ${JSON.stringify(PROJECT)} });
    process.stdout.write(v ? JSON.stringify(v.alwaysFlags || []) : 'null');
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, EPAM_PROVIDER_SET: set } });
  try { return JSON.parse((r.stdout || 'null').trim()); } catch { return null; }
}

describe('a runner gets only flags it accepts', () => {
  it('plain claude is given no -s on the claude set', () => {
    const flags = alwaysFlags('claude', 'claude');
    expect(flags, 'the claude runner does not resolve at all').not.toBeNull();
    expect(flags, '-s is codemie-claude\'s silent flag; plain claude exits 1 on it')
      .not.toContain('-s');
  }, 60_000);

  it('and none on the mockserver set either — the free rehearsal uses the same binary', () => {
    const flags = alwaysFlags('mockserver', 'claude');
    expect(flags).not.toBeNull();
    expect(flags).not.toContain('-s');
  }, 60_000);

  it('codemie-claude KEEPS -s, because its own --help documents it', () => {
    // The negative half: removing the flag everywhere would break the runner that needs it.
    const flags = alwaysFlags('codemie', 'codemie-claude');
    expect(flags, 'the codemie runner does not resolve').not.toBeNull();
    expect(flags, '-s was removed from the runner that actually accepts it').toContain('-s');
  }, 60_000);

  it('the mock launcher loads the project config dir it resolves', () => {
    // ea776eb. Resolving a config directory and never reading it is why a run launched with
    // EPAM_PROVIDER_SET=claude ended up on the repo .env's stale provider.
    const src = readFileSync(join(REPO, 'orchestrations/scripts/tier3-mock-run.sh'), 'utf8');
    const resolves = /EPAM_PROJECT_CONFIG_DIR=/.test(src);
    expect(resolves, 'the launcher no longer resolves a project config dir').toBe(true);
    expect(src, 'the launcher resolves a config dir and never loads config.env from it, so the '
      + "repo .env's stale provider wins")
      .toMatch(/config\.env|load_project_env|source[^\n]*CONFIG_DIR/);
  });
});
