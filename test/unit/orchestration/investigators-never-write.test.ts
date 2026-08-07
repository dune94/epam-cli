/**
 * AN INVESTIGATOR MUST NEVER BE ABLE TO WRITE, OR TO OWN A STORY.
 *
 * The roster now mints two classes of agent: implementers, which author code, and
 * investigators (per-codeline detectives), which read code and report what is there.
 *
 * Everything minted used to land in one registry — project-roles.json — and that registry is
 * exactly what the write perimeter reads to decide who may author code, and what story
 * assignment offers as candidates. Minting a detective through that path would have handed an
 * investigator write access to client source. That is the precise incident the perimeter was
 * built for: ~1050 lines rewritten during a spec pass, by agents that only needed to read.
 *
 * So the classes are routed to separate registries at mint time, and the perimeter reads only
 * one of them. Enforced in the merge rather than by convention, because the failure is silent:
 * an investigator with write access looks exactly like one without, right up until it writes.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');
const { FIXED_AGENT_ROLES } = require('../../../dist/sdk.js');
const PERIM = join(__dirname, '../../../orchestrations/scripts/lib/codeline-write-perimeter.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let prev: string | undefined;
beforeEach(() => { prev = process.env.EPAM_PROJECT_CONFIG_DIR; delete process.env.EPAM_PROJECT_CONFIG_DIR; });
afterAll(() => { if (prev !== undefined) process.env.EPAM_PROJECT_CONFIG_DIR = prev; });

const IMPL = { name: 'a-domain-engineer', kind: 'implementer', systemPrompt: 'owns src/. '.repeat(20), rationale: 'r' };
const INV = { name: 'a-codeline-detective', kind: 'investigator', systemPrompt: 'reads and reports. '.repeat(20), rationale: 'r' };

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'kinds-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ [FIXED_AGENT_ROLES[0]]: 'canonical' }, null, 2));
  return { dir, profilesPath };
}

/** Ask the REAL perimeter whether a name may write, with these registries on disk. */
function mayWrite(dir: string, profilesPath: string, name: string) {
  const res = spawnSync('bash', ['-c',
    `set +e; export AGENT_PROFILES_FILE=${JSON.stringify(profilesPath)}; ` +
    `source ${JSON.stringify(PERIM)} >/dev/null 2>&1; ` +
    `perimeter_role_may_write ${JSON.stringify(name)}; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  return /RC=0/.test((res.stdout || '') + (res.stderr || ''));
}

describe('the two classes go to separate registries', () => {
  it('an implementer lands in the write registry', () => {
    const { dir, profilesPath } = ws();
    const res = roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [IMPL] });
    expect(roster.projectRoles(dir)).toEqual([IMPL.name]);
    expect(res.minted[0].surfaces).toContain('project-roles');
  });

  it('THE SAFETY GATE: an investigator does NOT', () => {
    const { dir, profilesPath } = ws();
    const res = roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [INV] });
    expect(
      roster.projectRoles(dir),
      'a read-only investigator was registered where the write perimeter looks',
    ).toEqual([]);
    expect(roster.projectInvestigators(dir)).toEqual([INV.name]);
    expect(res.minted[0].surfaces).toContain('project-investigators');
  });

  it('both still get a brief and a KB', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [IMPL, INV] });
    const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
    expect(profiles[IMPL.name]).toBeTruthy();
    expect(profiles[INV.name], 'the detective has no brief, so it cannot investigate').toBeTruthy();
    expect(existsSync(join(dir, `KB-${INV.name}.md`))).toBe(true);
  });
});

describe('the write perimeter refuses investigators', () => {
  it('a minted investigator may not write', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [IMPL, INV] });
    expect(mayWrite(dir, profilesPath, IMPL.name), 'the implementer cannot write — harness wrong').toBe(true);
    expect(
      mayWrite(dir, profilesPath, INV.name),
      'an investigator can author client source — the incident this perimeter exists for',
    ).toBe(false);
  });
});

describe('an unrecognised kind is refused, not coerced', () => {
  it('a bogus kind is rejected rather than defaulting to implementer', () => {
    const { dir, profilesPath } = ws();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ ...INV, kind: 'detective' }],
    });
    expect(res.minted).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/unrecognised kind/i);
    expect(
      roster.projectRoles(dir),
      'coercing an unknown kind to implementer grants write access silently',
    ).toEqual([]);
  });

  it('an unstated kind defaults to implementer — the pre-existing shape still works', () => {
    const { dir, profilesPath } = ws();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'legacy-engineer', systemPrompt: 'x'.repeat(80), rationale: 'r' }],
    });
    expect(res.minted[0].kind).toBe('implementer');
    expect(roster.projectRoles(dir)).toEqual(['legacy-engineer']);
  });
});

describe('clearing removes both registries', () => {
  it('an investigator does not survive into the next run', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [IMPL, INV] });
    const cleared = roster.clearProjectRoster(dir, profilesPath);
    expect(cleared).toEqual(expect.arrayContaining([IMPL.name, INV.name]));
    expect(roster.projectRoles(dir)).toEqual([]);
    expect(roster.projectInvestigators(dir)).toEqual([]);
  });
});
