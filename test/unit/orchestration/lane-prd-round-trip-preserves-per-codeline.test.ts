/**
 * A LANE MUST NOT INHERIT THE UNION AND MERGE IT BACK AS ITS OWN.
 *
 * Live 2026-08-09. Four runs were killed during the day, and the canonical PRD drifted a little
 * further on each one:
 *
 *     clean   VCs=14  fixSites=13   perCodeline: gotransit=4   upexpress=4  metrolinx=6
 *     after   VCs=14  fixSites=22   perCodeline: gotransit=14  upexpress=4  metrolinx=6
 *
 * gotransit's four criteria had been replaced by all fourteen — the whole union — and the fix
 * sites had inflated from 13 to 22.
 *
 * THE CYCLE. _filtered_prd builds each lane's PRD from canonical and copies the FLAT
 * verificationCriteria, which by design is the union across every lane. On a first run that is
 * harmless: the spec pass overwrites it with the lane's own findings before anything merges. On
 * a RESUME the spec pass is skipped — that is the entire point of resuming — so the lane never
 * replaces the inherited union, and mergeLaneIntoCanonical faithfully records
 * `verificationCriteriaPerCodeline[gotransit] = <the union>`. Every subsequent kill re-feeds a
 * larger union into a smaller lane's slot.
 *
 * Neither half is wrong on its own. The merge correctly stores what the lane reported; the lane
 * reported what it was handed. The defect is that the lane was handed the union in the first
 * place, and it has a second, worse consequence: on a resume the lane's WRITER and GATES read
 * that flat list too, so gotransit was being verified against criteria that describe files
 * existing only in metrolinx — the same defect already fixed at the deliverable gate and the
 * prompt renderer, arriving through a third door.
 *
 * THE FIX belongs where _filtered_prd already solves this exact problem for `codeline` and
 * `agentRole`: a lane's PRD must state that LANE's truth. When canonical carries a per-codeline
 * entry for this lane, the lane's flat list is that entry — so the writer sees its own criteria,
 * and the merge stores back what it was given, unchanged.
 *
 * The round trip is the invariant worth pinning, because it is what actually broke:
 * filter -> (no spec pass) -> merge must leave canonical byte-identical. Anything else
 * accumulates.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const MERGE = join(__dirname, '../../../orchestrations/scripts/lib/story-merge.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeLaneIntoCanonical } = require(MERGE);

const NODE = process.execPath;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CODELINES = ['gotransit', 'upexpress', 'metrolinx'];
const VC = {
  gotransit: ['go-1', 'go-2', 'go-3', 'go-4'],
  upexpress: ['up-1', 'up-2', 'up-3', 'up-4'],
  metrolinx: ['mx-1', 'mx-2', 'mx-3', 'mx-4', 'mx-5', 'mx-6'],
} as Record<string, string[]>;
const FS = {
  gotransit: [{ file: 'src/go.ts', codeline: 'gotransit' }],
  upexpress: [{ file: 'src/up.ts', codeline: 'upexpress' }],
  metrolinx: [{ file: 'src/mx.ts', codeline: 'metrolinx' }],
} as Record<string, Array<Record<string, string>>>;

/** Canonical after a completed spec pass: per-codeline truth plus the derived union. */
function canonicalPrd() {
  return {
    project: { name: 'metrolinx' },
    stories: [{
      id: 'AMSD-2041',
      title: 'live preview',
      codeline: 'gotransit',
      codelines: [...CODELINES],
      verificationCriteria: CODELINES.flatMap((c) => VC[c]),          // the union — 14
      verificationCriteriaPerCodeline: { ...VC },
      fixSiteAnalysis: CODELINES.flatMap((c) => FS[c]),
      fixSiteAnalysisPerCodeline: { ...FS },
    }],
    implementationOrder: { core: ['AMSD-2041'] },
  };
}

/** Runs the REAL _filtered_prd for one codeline and returns the lane PRD it wrote. */
function filteredPrd(canonical: unknown, codeline: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lanerd-')); dirs.push(dir);
  const src = join(dir, 'canonical.json');
  const out = join(dir, `${codeline}-prd.json`);
  writeFileSync(src, JSON.stringify(canonical, null, 2));

  const body = readFileSync(ORCH, 'utf8');
  const start = body.indexOf('  _filtered_prd() {');
  expect(start, '_filtered_prd not found').toBeGreaterThan(-1);
  const end = body.indexOf('\n  }\n', start);
  const fn = body.slice(start, end + 5);

  execFileSync('bash', ['-c',
    `set -u
     NODE_BIN=${JSON.stringify(NODE)}
     JIRA_DEFAULT_CODELINE=""
${fn}
     _filtered_prd ${JSON.stringify(codeline)} ${JSON.stringify(out)} ${JSON.stringify(src)}`,
  ], { encoding: 'utf8' });

  return JSON.parse(readFileSync(out, 'utf8'));
}

describe('the fixture is the post-spec canonical shape', () => {
  it('per-codeline lists differ from each other and the union is their sum', () => {
    const s = canonicalPrd().stories[0];
    expect(s.verificationCriteria).toHaveLength(14);
    expect(s.verificationCriteriaPerCodeline.gotransit).toHaveLength(4);
    expect(s.verificationCriteriaPerCodeline.metrolinx).toHaveLength(6);
  });
});

describe("THE DEFECT: a lane's PRD carries that lane's criteria", () => {
  it('gotransit gets its own four, not the union of fourteen', () => {
    const lane = filteredPrd(canonicalPrd(), 'gotransit');
    expect(
      lane.stories[0].verificationCriteria,
      "the lane's writer and gates verify against other codelines' criteria",
    ).toEqual(VC.gotransit);
  });

  it('metrolinx gets its own six', () => {
    expect(filteredPrd(canonicalPrd(), 'metrolinx').stories[0].verificationCriteria).toEqual(VC.metrolinx);
  });

  it('fix sites are scoped the same way', () => {
    expect(filteredPrd(canonicalPrd(), 'gotransit').stories[0].fixSiteAnalysis).toEqual(FS.gotransit);
  });

  it('no other codeline appears in the lane PRD at all', () => {
    const text = JSON.stringify(filteredPrd(canonicalPrd(), 'gotransit').stories[0].verificationCriteria);
    expect(text).not.toContain('up-');
    expect(text).not.toContain('mx-');
  });

  it('the lane still knows it spans three codelines', () => {
    // Scoping the criteria must not hide that this is a spanning story — the merge depends on it.
    expect(filteredPrd(canonicalPrd(), 'gotransit').stories[0].codelines).toEqual(CODELINES);
  });
});

describe('THE CYCLE: filter then merge, with no spec pass, changes nothing', () => {
  /** One resumed lane: filter out, merge straight back, no spec pass in between. */
  function roundTrip(canonical: ReturnType<typeof canonicalPrd>, codeline: string) {
    const lane = filteredPrd(canonical, codeline);
    return mergeLaneIntoCanonical({ canonical, updated: lane, codeline });
  }

  it("gotransit's slot still holds four criteria after a resume merge", () => {
    const after = roundTrip(canonicalPrd(), 'gotransit');
    expect(
      after.stories[0].verificationCriteriaPerCodeline.gotransit,
      "the lane's slot was overwritten with the union — this is the live corruption",
    ).toEqual(VC.gotransit);
  });

  it('the union stays at fourteen, not fourteen plus fourteen', () => {
    expect(roundTrip(canonicalPrd(), 'gotransit').stories[0].verificationCriteria).toHaveLength(14);
  });

  it('fix sites stay at three, not eleven', () => {
    // The live inflation was 13 -> 22 by exactly this route.
    expect(roundTrip(canonicalPrd(), 'gotransit').stories[0].fixSiteAnalysis).toHaveLength(3);
  });

  it('the OTHER lanes are untouched by one lane resuming', () => {
    const after = roundTrip(canonicalPrd(), 'gotransit').stories[0];
    expect(after.verificationCriteriaPerCodeline.upexpress).toEqual(VC.upexpress);
    expect(after.verificationCriteriaPerCodeline.metrolinx).toEqual(VC.metrolinx);
  });

  it('four consecutive resumes drift by nothing at all', () => {
    // The live signature was cumulative: each killed run enlarged the slot again.
    let prd = canonicalPrd();
    for (let i = 0; i < 4; i++) for (const cl of CODELINES) prd = roundTrip(prd, cl) as typeof prd;
    const s = prd.stories[0];
    expect(s.verificationCriteria).toHaveLength(14);
    expect(s.fixSiteAnalysis).toHaveLength(3);
    for (const cl of CODELINES) expect(s.verificationCriteriaPerCodeline[cl]).toEqual(VC[cl]);
  });
});

describe('a first run — no per-codeline data yet — is unchanged', () => {
  it('a lane inherits the flat list when canonical has no per-codeline entry', () => {
    // Before the spec pass there is nothing to scope to, and the flat list is all there is.
    const prd = canonicalPrd();
    const s = prd.stories[0] as Record<string, unknown>;
    delete s.verificationCriteriaPerCodeline;
    delete s.fixSiteAnalysisPerCodeline;
    const lane = filteredPrd(prd, 'gotransit');
    expect(lane.stories[0].verificationCriteria).toHaveLength(14);
  });

  it('a codeline absent from the per-codeline map inherits the flat list', () => {
    // A lane added after the spec pass ran has no entry, and must not be handed an empty plan.
    const lane = filteredPrd(canonicalPrd(), 'gotransit');
    expect(lane.stories[0].verificationCriteria.length).toBeGreaterThan(0);
    const prd = canonicalPrd();
    prd.stories[0].codelines = [...CODELINES, 'newline'];
    const fresh = filteredPrd(prd, 'newline');
    expect(fresh.stories[0].verificationCriteria).toHaveLength(14);
  });

  it('an explicitly EMPTY per-codeline entry is honoured, not treated as absent', () => {
    // "This lane found nothing to verify" is a real state and differs from "has not run".
    const prd = canonicalPrd();
    prd.stories[0].verificationCriteriaPerCodeline.gotransit = [];
    expect(filteredPrd(prd, 'gotransit').stories[0].verificationCriteria).toEqual([]);
  });

  it('a single-codeline story is untouched', () => {
    const prd = canonicalPrd();
    prd.stories[0].codelines = ['gotransit'];
    expect(filteredPrd(prd, 'gotransit').stories[0].verificationCriteria).toEqual(VC.gotransit);
  });
});
