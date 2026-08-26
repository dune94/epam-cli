/**
 * A MINTED AGENT THAT CANNOT WRITE IS AN AGENT THAT CANNOT WORK.
 *
 * The write perimeter is enforced below the tool layer with chmod, so it is not something a
 * prompt can talk its way past — which is the point. It decides by ROLE NAME against a list:
 *
 *   _PERIMETER_DEFAULT_WRITE_ROLES="writer,typescript-engineer,test-engineer,repro-test-writer,lint-fix"
 *
 * whose own comment reads "Configurable per project, never hardcoded to one pipeline's role
 * names". Two of those five ARE one pipeline's role names — epam-cli's, from its first commit.
 *
 * A role minted for a project is in none of them. It would be proposed, briefed, wired, given
 * inputs and tools, assigned a story — and then be structurally unable to write a single byte.
 * Every attempt fails, the ladder climbs, the budget exhausts, and nothing in the logs says
 * "this agent was never allowed to write". That is the failure this test exists to prevent.
 *
 * The rule that replaces the list: a role may write if it has a profile of its own AND is not
 * part of the canonical process core. Derived from the roster, so a role minted tomorrow is
 * covered without editing this file.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PERIM = join(__dirname, '../../../orchestrations/scripts/lib/codeline-write-perimeter.sh');
const { FIXED_AGENT_ROLES } = require('../../../dist/sdk.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ROSTER = {
  [FIXED_AGENT_ROLES[0]]: 'a canonical process role',
  'review-agent': 'reads to judge, never writes',
  'some-domain-engineer': 'a role minted for THIS project',
  'another-domain-specialist': 'another minted role',
};

/** Ask the REAL perimeter whether a role may write, with a given roster on disk. */
function mayWrite(role: string, roster: Record<string, string> = ROSTER) {
  const dir = mkdtempSync(join(tmpdir(), 'perim-roles-')); dirs.push(dir);
  const profiles = join(dir, 'profiles.json');
  writeFileSync(profiles, JSON.stringify(roster, null, 2));
  // THE PERIMETER READS THE PROJECT ROSTER.
  //
  // This wrote project-roles.json — the registry the perimeter used to consult. It now resolves
  // implementers through project-roster.js from <project>/roster.json, keyed on
  // EPAM_PROJECT_CONFIG_DIR, and with that unset it returns nothing and refuses every role. A
  // minted role therefore read as "structurally unable to write" when the guard was correct and
  // the harness was asking the question with no project.
  const MINTED = ['some-domain-engineer', 'another-domain-specialist'];
  writeFileSync(join(dir, 'roster.json'), JSON.stringify({
    agents: Object.fromEntries(Object.keys(roster).map((name) => [name, {
      // Only the minted domain roles implement; the canonical process role and the reviewer do
      // not, which is the distinction the perimeter exists to enforce.
      kind: MINTED.includes(name) ? 'implementer' : 'investigator',
      persona: String(roster[name]),
      ancestor: 'canonical',
      derivedFromSha256: '0'.repeat(64),
    }])),
  }, null, 2));
  const res = spawnSync('bash', ['-c',
    `set +e; export AGENT_PROFILES_FILE=${JSON.stringify(profiles)}; ` +
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(dir)}; ` +
    `source ${JSON.stringify(PERIM)} >/dev/null 2>&1; ` +
    `perimeter_role_may_write ${JSON.stringify(role)}; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  return { allowed: /RC=0/.test(out), out };
}

describe('the harness is real', () => {
  it('an authoring seam may write and an unknown caller may not', () => {
    expect(mayWrite('writer').allowed, 'the writer itself was refused — harness is wrong').toBe(true);
    expect(mayWrite('').allowed).toBe(false);
  });
});

describe('a minted project role may write', () => {
  it('THE GAP: a role minted for this project is permitted', () => {
    expect(
      mayWrite('some-domain-engineer').allowed,
      'a minted agent is assigned stories it is structurally unable to write — every ' +
      'attempt fails, the ladder exhausts, and no log says why',
    ).toBe(true);
  });

  it('a second minted role is permitted too — this is a rule, not a patch', () => {
    expect(mayWrite('another-domain-specialist').allowed).toBe(true);
  });

  it('a ":plan" suffix is still stripped', () => {
    expect(mayWrite('some-domain-engineer:plan').allowed).toBe(true);
  });
});

describe('read-only roles are still refused', () => {
  it('a canonical process role may not write', () => {
    expect(
      mayWrite(FIXED_AGENT_ROLES[0]).allowed,
      'a gate/sentinel gained write access — this is how client source was rewritten ' +
      'during a spec pass with no writer running',
    ).toBe(false);
  });

  it('the reviewer may not write', () => {
    expect(mayWrite('review-agent').allowed).toBe(false);
  });

  it('a role with no profile at all may not write', () => {
    expect(mayWrite('never-heard-of-this-one').allowed).toBe(false);
  });
});

describe('the explicit override still wins', () => {
  it('EPAM_PERIMETER_WRITE_ROLES overrides the derivation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perim-override-')); dirs.push(dir);
    const profiles = join(dir, 'profiles.json');
    writeFileSync(profiles, JSON.stringify(ROSTER, null, 2));
    writeFileSync(join(dir, 'project-roles.json'), JSON.stringify({
      roles: ['some-domain-engineer', 'another-domain-specialist'],
    }));
    const res = spawnSync('bash', ['-c',
      `set +e; export AGENT_PROFILES_FILE=${JSON.stringify(profiles)}; ` +
      `export EPAM_PERIMETER_WRITE_ROLES="only-this-one"; ` +
      `source ${JSON.stringify(PERIM)} >/dev/null 2>&1; ` +
      `perimeter_role_may_write "some-domain-engineer"; echo "A=$?"; ` +
      `perimeter_role_may_write "only-this-one"; echo "B=$?"`,
    ], { encoding: 'utf8' });
    const out = (res.stdout || '') + (res.stderr || '');
    expect(out, 'an explicit operator override was ignored').toMatch(/A=1/);
    expect(out).toMatch(/B=0/);
  });
});
