/**
 * A MINTED AGENT MUST REACH THE SETTLED ROSTER — ON EVERY MODE, NOT JUST ONE.
 *
 * ba9cee7 (2026-08-22) stopped the mint writing into the engine's agents/profiles.json, because one
 * project's agents were reaching another's roster. The briefs moved to <project>/agent-profiles.json
 * and the settled roster to <project>/roster.json. Readers were left behind, one at a time:
 *
 *   1. candidateRoles in spec-mode-runner
 *   2. the assignment check in mint-agents-step
 *   3. buildProjectRoster's DERIVE path — this one
 *
 * withMintedAgents() merges <project>/agent-profiles.json into the roster, and it was called from
 * exactly one place: the `mode === 'canonical'` early return. metrolinx declares no rosterMode, so
 * it defaults to 'derive', and on that path minted agents were silently dropped.
 *
 * IT ONLY BITES ON RESUME, which is why it survived. A first run mints the agent and writes its
 * assignment in the same step, so the roster holds it. A RESUME sets EPAM_SKIP_AGENT_MINT=1 and
 * re-derives the roster from canonical — the minted agent is gone, and the assignment written two
 * hours earlier now names a role that does not exist.
 *
 * Live 2026-09-01, run 20260901T224029Z, resuming from the post-roster checkpoint:
 *
 *   [roster] accepted 47 agent(s)
 *   FAILED: 1 assignment(s) name a role that is not in the settled roster:
 *           AMSD-1919/gotransit -> checkout-form-engineer
 *   [ERROR] roster derivation FAILED — refusing to continue with agents that have no identity.
 *
 * The gate was right to refuse. agent-profiles.json had held the brief since 18:43:59; the roster
 * was rebuilt at 20:33:19 and did not read it.
 *
 * THE ROSTER ON DISK IS WHAT COUNTS. The assignment check reads roster.json, not the value this
 * function returns, so a merge that is not persisted fixes nothing. Asserted separately below.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(join(REPO, 'orchestrations/scripts/lib/project-roster.js'));

const MINTED = 'fixture-payments-engineer';
const MINTED_BRIEF = 'You are a payments engineer minted for this project fixture.';

/** A project whose mint has already run: a brief on disk and the role registered. */
function project(rosterMode?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'roster-mode-'));
  const logDir = join(dir, 'logs'); mkdirSync(logDir, { recursive: true });

  writeFileSync(join(dir, 'agent-profiles.json'), JSON.stringify({
    runId: 'FIXTURE', profiles: { [MINTED]: MINTED_BRIEF },
  }));
  // Registered as an implementer — this is what gives kindOfAgent a kind to record.
  writeFileSync(join(dir, 'project-roles.json'), JSON.stringify({
    _what: 'fixture', roles: [MINTED],
  }));
  writeFileSync(join(dir, 'project-investigators.json'), JSON.stringify({
    investigators: [], byCodeline: {},
  }));
  if (rosterMode) writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify({ rosterMode }));

  // A canonical roster the specialiser will copy verbatim.
  const canonical = { 'team-lead-agent': 'You are the team lead.', 'review-agent': 'You review.' };
  const canonicalPath = join(dir, 'profiles.canonical.json');
  writeFileSync(canonicalPath, JSON.stringify(canonical));
  return { dir, logDir, canonicalPath, canonical };
}

/** The specialiser: writes a roster that copies canonical verbatim, as a passing one does. */
function produceFrom(canonical: Record<string, string>) {
  return async ({ outPath }: any) => {
    const agents: any = {};
    for (const [name, persona] of Object.entries(canonical)) {
      agents[name] = {
        persona, kind: 'seam', ancestor: name,
        derivedFromSha256: roster.personaDigest(persona),
        rationale: 'copied verbatim by the fixture specialiser',
      };
    }
    writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
  };
}

async function build(rosterMode?: string) {
  const p = project(rosterMode);
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
  process.env.EPAM_PROJECT_CONFIG_DIR = p.dir;
  try {
    const out = await roster.buildProjectRoster({
      canonicalPath: p.canonicalPath,
      logDir: p.logDir,
      projectConfigDir: p.dir,
      produce: produceFrom(p.canonical),
      log: () => {},
    });
    const onDisk = JSON.parse(readFileSync(roster.projectRosterPath(p.dir), 'utf8'));
    return { returned: out, onDisk };
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR;
    else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
  }
}

describe('a minted agent survives into the settled roster', () => {
  it('the fixture is real — canonical agents come through on the derive path', async () => {
    // Non-vacuity: if the build produced nothing, every assertion below passes on an empty roster.
    const { returned } = await build();
    expect(Object.keys(returned.agents).length,
      'the fixture specialiser produced no roster').toBeGreaterThan(1);
    expect(returned.agents['team-lead-agent'], 'a canonical agent was lost').toBeTruthy();
  });

  it('CANONICAL mode carries the minted agent (the path that already worked)', async () => {
    const { returned } = await build('canonical');
    expect(returned.agents[MINTED],
      'the canonical path stopped merging minted agents').toBeTruthy();
  });

  it('DERIVE mode carries it too — THE DEFECT', async () => {
    const { returned } = await build();
    expect(returned.agents[MINTED],
      'the derive path dropped the minted agent: this is the 2026-09-01 resume failure, where '
      + 'the assignment written at mint time named a role the re-derived roster no longer held')
      .toBeTruthy();
  });

  it('AND IT IS PERSISTED — the assignment check reads roster.json, not the return value', async () => {
    const { onDisk } = await build();
    expect(onDisk.agents[MINTED],
      'the minted agent is in the returned roster but not in the file the assignment check reads')
      .toBeTruthy();
  });

  it('the minted entry carries the provenance every roster entry must have', async () => {
    // checkEntry refuses an agent with no ancestor: without it there is no ladder, no tool grant
    // and no output contract, and something downstream has to invent them.
    const { onDisk } = await build();
    const e = onDisk.agents[MINTED];
    expect(e && e.persona, 'no persona').toBe(MINTED_BRIEF);
    expect(e && e.kind, 'the minted agent has no declared kind').toBe('implementer');
    expect(e && e.ancestor, 'no ancestor recorded').toBeTruthy();
  });

  it('canonical still wins a name collision — the mint never shadows a process role', async () => {
    // The guard inside withMintedAgents. A project must not be able to replace a process role by
    // minting one with the same name.
    const p = project();
    writeFileSync(join(p.dir, 'agent-profiles.json'), JSON.stringify({
      profiles: { 'team-lead-agent': 'HIJACKED BY THE MINT' },
    }));
    writeFileSync(join(p.dir, 'project-roles.json'), JSON.stringify({ roles: ['team-lead-agent'] }));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
    process.env.EPAM_PROJECT_CONFIG_DIR = p.dir;
    try {
      const out = await roster.buildProjectRoster({
        canonicalPath: p.canonicalPath, logDir: p.logDir, projectConfigDir: p.dir,
        produce: produceFrom(p.canonical), log: () => {},
      });
      expect(out.agents['team-lead-agent'].persona,
        'a minted agent overwrote a canonical process role').toBe('You are the team lead.');
    } finally {
      if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR;
      else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
    }
  });
});
