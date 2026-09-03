/**
 * THE HARNESS DISCOVERS ITS SUBJECT. IT NEVER NAMES ONE.
 *
 * agent-check.js defaulted to `--codeline metrolinx` and `--story AMSD-2041`. Two costs:
 * it made the harness name the very things the engine is forbidden to name (the standing
 * guard the-engine-names-no-project caught it), and an unflagged run silently checked every
 * agent against ONE project's data while reporting a pass.
 *
 * Both are now DISCOVERED — the codeline from the project config dir an operator already
 * exports, or from the single project on disk; the story from that project's own PRD.
 * Ambiguity is an ERROR that lists the real choices, because a guess here validates agents
 * against the wrong project and calls it green.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const HARNESS = join(ROOT, 'orchestrations/scripts/agent-check.js');
const NODE = process.execPath;

const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(NODE, [HARNESS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: '', ...env },
  });

const projects = readdirSync(join(ROOT, 'orchestrations/projects'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

describe('the harness names no project', () => {
  it('carries no project or story literal in its executable lines', () => {
    const code = readFileSync(HARNESS, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/['"`]metrolinx['"`]/i);
    expect(code).not.toMatch(/['"`]AMSD-\d+['"`]/i);
  });

  it('with several projects and no flag: exits non-zero and LISTS the real choices', () => {
    // Guard against a vacuous pass: this test only means something with >1 project on disk.
    expect(projects.length).toBeGreaterThan(1);

    const r = run(['--dry']);
    expect(r.status, 'a harness that cannot know its subject must not proceed').not.toBe(0);
    const msg = (r.stderr || '') + (r.stdout || '');
    for (const p of projects) expect(msg, `error should name ${p} as a choice`).toContain(p);
    expect(msg).toMatch(/--codeline/);
  });

  it('does not silently pick a project when none is given', () => {
    const r = run(['--dry']);
    const msg = (r.stderr || '') + (r.stdout || '');
    // It must ASK, not choose — the failure text is a prompt, not a result.
    expect(msg).not.toMatch(/seam|batch|checking/i);
  });

  it('accepts the codeline from the env an operator already exports', () => {
    const r = run(['--dry'], { EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects', projects[0]) });
    const msg = (r.stderr || '') + (r.stdout || '');
    expect(msg, 'a discoverable codeline must not raise the codeline error')
      .not.toMatch(/no codeline given/);
  });
});
