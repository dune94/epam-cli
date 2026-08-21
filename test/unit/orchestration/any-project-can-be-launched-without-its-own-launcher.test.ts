/**
 * A PROJECT IS DATA, SO LAUNCHING ONE MUST NOT REQUIRE A SCRIPT NAMED AFTER IT.
 *
 * A project declares everything a run needs in its own config.env — the codeline root, the scope
 * bound, the provisioning mode, its models. Nothing generic loaded that file. The one launcher that
 * works names its project twice by hardcoded path:
 *
 *     PROJECT_CONFIG="$SCRIPT_DIR/../projects/metrolinx/config.env"
 *     export EPAM_PROJECT_CONFIG_DIR="$SCRIPT_DIR/../projects/metrolinx"
 *
 * So a project without its own launcher runs with none of its data applied: no codeline root, so
 * scope resolution no-ops and the run collapses to a single lane; no scope bound on the
 * destructive reset; and no provisioning mode, which the mint refuses to default.
 *
 * 25 of that launcher's 588 lines name the project. The rest is generic work being copied per
 * project.
 *
 * These tests describe the generic launcher: it takes the project as an ARGUMENT, loads that
 * project's data, and refuses clearly when asked for one that does not exist. It names no project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const LAUNCHER = join(ROOT, 'orchestrations/scripts/tier3-run.sh');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'generic-launcher-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/**
 * Run the launcher in DESCRIBE mode: resolve the project, load its data, print what a run would
 * use, and stop before spending anything. A launcher that can only be tested by launching cannot
 * be tested.
 */
function describeRun(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [LAUNCHER, ...args, '--describe'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('any project can be launched without its own launcher', () => {
  it('the generic launcher exists', () => {
    expect(existsSync(LAUNCHER),
      'every project still needs a launcher named after it to have its config.env loaded').toBe(true);
  });

  it('names no project of its own', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    // Its whole purpose is that the project is an argument. A name here is the defect returning.
    const projects = readdirSync(join(ROOT, 'orchestrations/projects'));
    const named = projects.filter((p: string) => new RegExp(`\\b${p}\\b`).test(src));
    expect(named, `the launcher names ${named.join(', ')} — a project is data, not a code path`).toEqual([]);
  });

  it('loads the named project config.env and exports its directory', () => {
    const projects = join(work, 'projects');
    const dir = join(projects, 'demo-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.env'), [
      'JIRA_CODELINE_ROOT=/somewhere/demo',
      'EPAM_PROMPT_PROVISION_MODE=generate',
    ].join('\n'));

    const r = describeRun(['--project', 'demo-project'], { EPAM_PROJECTS_DIR: projects });
    expect(r.status, `launcher exited ${r.status}: ${r.stderr}`).toBe(0);

    expect(r.stdout, 'the project config dir was not exported, so nothing downstream can find it')
      .toContain(dir);
    expect(r.stdout, 'the codeline root the project declares was not loaded — scope resolution '
      + 'would no-op and the run would collapse to one lane').toContain('/somewhere/demo');
    expect(r.stdout, 'the provisioning mode was not loaded, and the mint refuses to default it')
      .toContain('generate');
  });

  it('lets a caller-exported value win over the project file', () => {
    // `preserve` semantics: an operator overriding for one run must not be silently reverted by
    // the project's declaration — that is how a deliberate override becomes an invisible no-op.
    const projects = join(work, 'projects');
    const dir = join(projects, 'demo-project');
    mkdirSync(dir, { recursive: true });
    // Demonstrated on the provisioning mode. It used to be demonstrated on
    // EPAM_ONLY_CODELINES, which is deleted — the run's codeline scope is read from the PRD
    // now, not declared by hand — but `preserve` semantics are not about that variable.
    writeFileSync(join(dir, 'config.env'), 'EPAM_PROMPT_PROVISION_MODE=generate\n');

    const r = describeRun(['--project', 'demo-project'],
      { EPAM_PROJECTS_DIR: projects, EPAM_PROMPT_PROVISION_MODE: 'reuse' });
    expect(r.stdout, 'the project file overwrote an explicit caller override').toContain('reuse');
  });

  it('refuses a project that does not exist, naming what it looked for', () => {
    const r = describeRun(['--project', 'no-such-project'], { EPAM_PROJECTS_DIR: join(work, 'projects') });
    expect(r.status, 'launching a project that does not exist was not refused').not.toBe(0);
    expect(r.stderr + r.stdout, 'the refusal does not say what it looked for')
      .toMatch(/no-such-project/);
  });

  it('refuses when no project is named at all rather than guessing one', () => {
    const r = describeRun([], { EPAM_PROJECTS_DIR: join(work, 'projects'), EPAM_PROJECT_CONFIG_DIR: '' });
    expect(r.status, 'the launcher picked a project nobody named').not.toBe(0);
  });

  it('accepts the project as an already-exported directory', () => {
    // The path a caller takes when the project lives outside the standard directory.
    const dir = join(work, 'elsewhere', 'a-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.env'), 'JIRA_CODELINE_ROOT=/elsewhere/root\n');

    const r = describeRun([], { EPAM_PROJECT_CONFIG_DIR: dir });
    expect(r.status, `launcher exited ${r.status}: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('/elsewhere/root');
  });
});
