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

const IMPL = { name: 'a-domain-engineer', kind: 'implementer', codeline: '*', systemPrompt: 'owns src/. '.repeat(20), rationale: 'Nothing in the canonical core owns this part of the estate.' };
// codeline is REQUIRED for an investigator: the lane resolves it by codeline, so one
// naming none is unreachable and the merge refuses it.
const INV = { name: 'a-codeline-detective', kind: 'investigator', codeline: 'alpha', systemPrompt: 'reads and reports. '.repeat(20), rationale: 'Nothing in the canonical core owns this part of the estate.' };

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'kinds-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ [FIXED_AGENT_ROLES[0]]: 'canonical' }, null, 2));
  return { dir, profilesPath };
}

/** Ask the REAL perimeter whether a name may write, with these registries on disk. */
/**
 * THE PERIMETER READS THE PROJECT ROSTER, NOT THE ENGINE PROFILES.
 *
 * This exported AGENT_PROFILES_FILE and nothing else. _perimeter_project_roles resolves
 * implementers through project-roster.js keyed on EPAM_PROJECT_CONFIG_DIR, and with that unset
 * it returns nothing and refuses EVERY role — so the harness reported a legitimate implementer
 * as blocked and a minted role as structurally unable to write. The guard was behaving
 * correctly; it was being asked the question with no project.
 *
 * mergeProjectAgents stopped writing an engine-wide registry (one project's agents were reaching
 * another's roster). The roster lands at <project>/roster.json, so that is what the harness
 * supplies — the artefact production actually hands the perimeter.
 */
function writeRoster(dir: string, agents: Array<{ name: string; kind: string }>) {
  writeFileSync(join(dir, 'roster.json'), JSON.stringify({
    agents: Object.fromEntries(agents.map((a) => [a.name, {
      kind: a.kind,
      persona: `A ${a.kind} agent, for the perimeter to classify.`,
      ancestor: 'canonical',
      derivedFromSha256: '0'.repeat(64),
    }])),
  }, null, 2));
}

function mayWrite(dir: string, profilesPath: string, name: string) {
  const res = spawnSync('bash', ['-c',
    `set +e; export AGENT_PROFILES_FILE=${JSON.stringify(profilesPath)}; ` +
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(dir)}; ` +
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

  // KB-1 (2026-08-08): stores are per CODELINE, not per role. A role-keyed file was written
  // at an address nothing reads — 41 accumulated, all unreadable, KB coverage 0%.
  it('both still get a brief, and the codeline store exists', () => {
    const { dir, profilesPath } = ws();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir, codelines: [{ name: INV.codeline }], proposals: [IMPL, INV],
    });
    // THE ENGINE ROSTER IS DELIBERATELY NOT WRITTEN.
    //
    // This read profilesPath expecting both agents to appear there. mergeProjectAgents stopped
    // writing orchestrations/agents/profiles.json because every project shares it, so one
    // project's agents were reaching another's roster and a client codeline ran with this
    // repository's own. The briefs are RETURNED to the caller, which hands them to the
    // roster-specialiser. Asserting the old surface made a deliberate isolation fix look like
    // a lost brief.
    const minted = Object.fromEntries(res.minted.map((m: any) => [m.name, m]));
    expect(minted[IMPL.name], 'the implementer has no brief').toBeTruthy();
    expect(minted[INV.name], 'the detective has no brief, so it cannot investigate').toBeTruthy();
    // The store the seams actually read: per CODELINE. A role-keyed file was written at an
    // address nothing reads (41 accumulated, KB coverage 0%).
    expect(existsSync(roster.kbFileForCodeline(dir, INV.codeline))).toBe(true);
  });
});

describe('the write perimeter refuses investigators', () => {
  it('a minted investigator may not write', () => {
    const { dir, profilesPath } = ws();
    roster.mergeProjectAgents({ profilesPath, agentsDir: dir, proposals: [IMPL, INV] });
    // The roster the roster-specialiser produces every run, which is what the perimeter reads.
    writeRoster(dir, [IMPL, INV].map((a) => ({ name: a.name, kind: a.kind })));
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
      proposals: [{ name: 'legacy-engineer', codeline: '*', systemPrompt: 'x'.repeat(80), rationale: 'Nothing in the canonical core owns this part of the estate.' }],
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

/**
 * EVERY PROPOSAL STATES ITS CODELINE — SILENCE IS NOT AN ANSWER.
 *
 * codeline was optional in the schema, because JSON Schema cannot require a field
 * conditionally on another. Prompt instructions carried the rest, and on 2026-08-07 a mint
 * returned three investigators, none naming a codeline and no implementers at all. The guard
 * refused all three, assignment found no roles, and the run halted with no roster — the
 * fail-closed chain working, and no run to show for it.
 *
 * The field is now required of BOTH kinds. An implementer that spans the project says so with
 * a sentinel rather than by omission, because a missing field cannot be told apart from a
 * model that simply skipped it.
 */
describe('every proposal must state a codeline', () => {
  const brief = 'a brief. '.repeat(30);
  function ws3() {
    const dir = mkdtempSync(join(tmpdir(), 'required-cl-')); dirs.push(dir);
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'review-agent': 'r' }, null, 2));
    return { dir, profilesPath };
  }

  it('an implementer that omits it is refused — not silently treated as project-wide', () => {
    const { dir, profilesPath } = ws3();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'an-engineer', kind: 'implementer', systemPrompt: brief, rationale: 'Nothing in the canonical core owns this part of the estate.' }],
    });
    expect(res.minted).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/must state a codeline/i);
  });

  it('an implementer spanning the project says so explicitly', () => {
    const { dir, profilesPath } = ws3();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'an-engineer', kind: 'implementer', codeline: roster.PROJECT_WIDE, systemPrompt: brief, rationale: 'Nothing in the canonical core owns this part of the estate.' }],
    });
    expect(res.minted).toHaveLength(1);
    expect(roster.projectRoles(dir)).toEqual(['an-engineer']);
  });

  it('the project-wide sentinel never becomes a codeline anything binds to', () => {
    const { dir, profilesPath } = ws3();
    roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'an-engineer', kind: 'implementer', codeline: roster.PROJECT_WIDE, systemPrompt: brief, rationale: 'Nothing in the canonical core owns this part of the estate.' }],
    });
    expect(roster.investigatorForCodeline(dir, roster.PROJECT_WIDE)).toBe('');
  });

  it('an investigator may NOT claim the whole project — a lane looks it up by codeline', () => {
    const { dir, profilesPath } = ws3();
    const res = roster.mergeProjectAgents({
      profilesPath, agentsDir: dir,
      proposals: [{ name: 'an-inv', kind: 'investigator', codeline: roster.PROJECT_WIDE, systemPrompt: brief, rationale: 'Nothing in the canonical core owns this part of the estate.' }],
    });
    expect(res.minted).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/must name ONE codeline/i);
  });
});
