/**
 * A RUN MUST NOT READ OR WRITE ANOTHER RUN'S ROSTER.
 *
 * Every site resolved the agents directory as $AUTOMATION_DIR/agents directly, so a run told to
 * keep its artefacts elsewhere still read and WROTE the live roster.
 *
 * Live 2026-08-08, caught by the estate integration harness: a test run's mint read the
 * repository's profiles.json — which held four agents a previous client run had minted — found
 * its own proposal already present, reported it "unchanged", minted nothing, and the run died
 * at assignment with "no project implementation roles are registered". It also wrote into the
 * client's agents directory on the way past. Two runs, one roster.
 *
 * EPAM_AGENTS_DIR is now the single resolution point. Unset, it is exactly the previous path,
 * so a normal run is unchanged.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(__dirname, '../../../');
const ORCH = readFileSync(join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Executes the real resolution lines under a given environment. */
function resolve(env: Record<string, string>): { agentsDir: string; profiles: string } {
  const start = ORCH.indexOf('EPAM_AGENTS_DIR="${EPAM_AGENTS_DIR:-');
  expect(start, 'the agents-dir resolution point is gone').toBeGreaterThan(-1);
  const block = ORCH.slice(start, ORCH.indexOf('\n', ORCH.indexOf('AGENT_PROFILES_FILE=', start)));

  const dir = mkdtempSync(join(tmpdir(), 'agents-dir-')); dirs.push(dir);
  const sh = join(dir, 'r.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\nset -u\nAUTOMATION_DIR=/repo/orchestrations\n${block}\n` +
    `printf '%s\\n%s\\n' "$EPAM_AGENTS_DIR" "$AGENT_PROFILES_FILE"\n`);
  const [agentsDir, profiles] = execFileSync('bash', [sh], {
    encoding: 'utf8', env: { ...process.env, EPAM_AGENTS_DIR: '', AGENT_PROFILES_FILE: '', ...env },
  }).trim().split('\n');
  return { agentsDir, profiles };
}

describe('unset, nothing changes for a normal run', () => {
  it('the agents dir is the automation directory, as it always was', () => {
    expect(resolve({}).agentsDir).toBe('/repo/orchestrations/agents');
  });

  it('the profiles file sits inside it', () => {
    expect(resolve({}).profiles).toBe('/repo/orchestrations/agents/profiles.json');
  });
});

describe('set, the run is redirected entirely', () => {
  it('the agents dir is the one the run was given', () => {
    expect(resolve({ EPAM_AGENTS_DIR: '/tmp/perimeter/agents' }).agentsDir).toBe('/tmp/perimeter/agents');
  });

  it('the profiles file follows it — not left behind in client space', () => {
    expect(
      resolve({ EPAM_AGENTS_DIR: '/tmp/perimeter/agents' }).profiles,
      'the roster would still be read from and written to the shared agents directory',
    ).toBe('/tmp/perimeter/agents/profiles.json');
  });

  it('an explicit AGENT_PROFILES_FILE still wins — the documented override', () => {
    expect(resolve({ EPAM_AGENTS_DIR: '/tmp/p/agents', AGENT_PROFILES_FILE: '/tmp/x/p.json' }).profiles)
      .toBe('/tmp/x/p.json');
  });
});

describe('the mint is handed the resolved directory, not a hardcoded one', () => {
  it('--agents-dir passes EPAM_AGENTS_DIR', () => {
    // The mint OWNS the roster: it clears, mints and registers. Handed the wrong directory it
    // reads another run's agents and writes over them.
    const i = ORCH.indexOf('--agents-dir');
    expect(ORCH.slice(i, i + 60)).toMatch(/--agents-dir "\$EPAM_AGENTS_DIR"/);
  });

  it('no site still resolves the agents directory by hand', () => {
    const offenders = ORCH.split('\n')
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => !line.trim().startsWith('#'))
      .filter(({ line }) => /AUTOMATION_DIR[}]?\/agents/.test(line))
      // the resolution point itself is where the default belongs
      .filter(({ line }) => !line.includes('EPAM_AGENTS_DIR:-'));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`),
      'a site bypasses the single resolution point').toEqual([]);
  });
});
