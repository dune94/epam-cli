/**
 * A MINTED AGENT DERIVES FROM ITS SEAM'S BASE SI — NEVER FROM ITSELF.
 *
 * Operator, 2026-09-29: "Bases and derived si must be matched to each seam. No deviations."
 * A minted agent used to be recorded as its OWN ancestor, its provenance a digest of its own brief,
 * so nothing tied a project's implementer to the writer's standing instructions. The engine now
 * records the seam the agent's declared KIND belongs to (the registry's seam patterns declare it),
 * and the digest of that seam's base SI.
 *
 * Executed through the functions the roster stage runs (composeFromDelta for the derive path,
 * withMintedAgents for rosterMode=canonical), against the real registry. Nothing expected is
 * written here: seams and digests are read from the declarations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'orchestrations', 'scripts', 'lib');
const REGISTRY = path.join(ROOT, 'orchestrations', 'agents', 'invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(path.join(LIB, 'project-roster.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamForKind } = require(path.join(LIB, 'seam-invocation.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentRoster = require(path.join(LIB, 'agent-roster.js'));
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let work = '';
let base: Record<string, string> = {};
const kinds = (reg.agentKinds as string[]).filter((k) => reg.agentKindMembership[k]);

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'minted-seam-'));
  base = JSON.parse(readFileSync(roster.seamBaseForRun(REGISTRY, work), 'utf8'));
  // The project's kind registries, written by the mint's own writers — never a hand-made shape.
  process.env.EPAM_PROJECT_CONFIG_DIR = work;
  const writers: Record<string, (d: string, n: string[]) => void> = {
    [agentRoster.PROJECT_ROLES_FILE]: agentRoster.registerProjectRoles,
    [agentRoster.PROJECT_INVESTIGATORS_FILE]: agentRoster.registerProjectInvestigators,
  };
  for (const k of kinds) {
    const write = writers[reg.agentKindMembership[k]];
    expect(typeof write).toBe('function');
    write(work, [`minted-${k}`]);
  }
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); delete process.env.EPAM_PROJECT_CONFIG_DIR; });

describe('the seam of a kind is read from the registry', () => {
  it('each minted kind maps to exactly one seam that carries a base si', () => {
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) {
      const seam = seamForKind(k, REGISTRY);
      expect(typeof base[seam]).toBe('string');
    }
  });
});

describe('derive path: a minted agent the specialiser adds', () => {
  it('names its kind\'s seam as ancestor, with the digest of that seam\'s base', () => {
    const delta = { agents: Object.fromEntries(kinds.map((k) => [`minted-${k}`, { persona: `brief for ${k}`, kind: k }])) };
    const { roster: r } = roster.composeFromDelta(delta, base);
    for (const k of kinds) {
      const e = r.agents[`minted-${k}`];
      const seam = seamForKind(k, REGISTRY);
      expect(e.ancestor).toBe(seam);
      expect(e.ancestor).not.toBe(`minted-${k}`);
      expect(e.derivedFromSha256).toBe(sha(base[seam]));
    }
  });
});

describe('canonical mode: minted agents adopted beside the base', () => {
  it('names its kind\'s seam as ancestor, with the digest of that seam\'s base', () => {
    agentRoster.saveProjectProfiles(work, Object.fromEntries(kinds.map((k) => [`minted-${k}`, `brief for ${k}`])));
    const start = { agents: Object.fromEntries(Object.entries(base).map(([s, t]) => [s, { persona: t, kind: 'seam', ancestor: s, derivedFromSha256: sha(t) }])) };
    const r = roster.withMintedAgents(start, work);
    for (const k of kinds) {
      const e = r.agents[`minted-${k}`];
      expect(e).toBeTruthy();
      const seam = seamForKind(k, REGISTRY);
      expect(e.ancestor).toBe(seam);
      expect(e.derivedFromSha256).toBe(sha(base[seam]));
    }
  });
});
