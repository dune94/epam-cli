/**
 * THE DELIVERABLE GATE MUST JUDGE A LANE BY ITS OWN CODELINE'S FILES.
 *
 * check_story_deliverables reads the declared file list with:
 *
 *     .stories[] | select(.id == $id) | .technicalNotes.files[]? // empty
 *
 * `.technicalNotes.files` is the UNION across every codeline. `.technicalNotes.perCodeline`
 * sits directly beside it holding the correct per-lane lists. So the gate asks a question
 * scoped to one lane and answers it with data scoped to all three.
 *
 * Live 2026-08-09, AMSD-2041: the union carried
 * src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx, which exists ONLY in
 * next.metrolinx.com. gotransit's writer was therefore required to produce a component that
 * does not belong in its repository, could not, and the story was rejected — an unwinnable
 * retry loop, since no amount of retrying makes a metrolinx component correct in gotransit.
 * upexpress would have failed identically. gotransit's own list (12 files) is right there and
 * does not contain it.
 *
 * This is the same defect shape as the lane-merge collapse: per-codeline data exists, a flat
 * union is read instead. Third instance at a different seam.
 *
 * `.codeline` is authoritative in a lane PRD — _filtered_prd stamps it per lane precisely so
 * consumers need not know lanes exist — so the selector needs no new input, env var or config.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

/**
 * The gate's own selector, lifted verbatim from the shipped script. Pinned to the real text so
 * this cannot pass against a paraphrase of the query.
 */
function shippedSelector(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const m = src.match(
    // Anchored on perCodeline — the selector that IS the codeline scoping. claude.sh contains
    // several `done < <(jq …)` loops over the PRD: the fixSiteAnalysis one (which yielded an
    // empty set, so every assertion compared against []) and _scope_lock's deliberate UNION
    // read (which is correct for scope-locking OTHER stories' files, and wrong to assert here).
    // Matching either tested a function this file is not about.
    /done < <\(jq -r --arg id "\$story_id" \\\n\s*'([^']*perCodeline[^']*)' \\\n\s*"\$prd_target"/,
  );
  expect(m, 'the deliverable jq selector was not found — this test is pinned to stale text').toBeTruthy();
  return (m as RegExpMatchArray)[1];
}

/** Runs the shipped selector against a PRD and returns the declared file list. */
function declaredFiles(prd: unknown): string[] {
  const out = execFileSync('jq', ['-r', '--arg', 'id', 'AMSD-2041', shippedSelector()], {
    input: JSON.stringify(prd),
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

const GOTRANSIT = [
  'src/services/contentstack.ts',
  'src/context/ContentstackContext.tsx',
  'src/pages/_app.tsx',
  'src/hooks/useContent.ts',
];
const METROLINX_ONLY = 'src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx';

/** The live shape: a lane PRD stamped with its codeline, a union list, and per-codeline lists. */
const lanePrd = (codeline: string) => ({
  stories: [{
    id: 'AMSD-2041',
    codeline,
    codelines: ['gotransit', 'upexpress', 'metrolinx'],
    technicalNotes: {
      files: [...GOTRANSIT, METROLINX_ONLY],          // the union — what the gate used to read
      perCodeline: {
        gotransit: { files: GOTRANSIT },
        upexpress: { files: GOTRANSIT },
        metrolinx: { files: [...GOTRANSIT, METROLINX_ONLY] },
      },
    },
  }],
});

describe('the fixture reproduces the live shape', () => {
  it('the union contains a file that belongs to one codeline only', () => {
    const prd = lanePrd('gotransit');
    const tn = prd.stories[0].technicalNotes;
    expect(tn.files).toContain(METROLINX_ONLY);
    expect(tn.perCodeline.gotransit.files).not.toContain(METROLINX_ONLY);
    expect(tn.perCodeline.metrolinx.files).toContain(METROLINX_ONLY);
  });
});

describe('THE DEFECT: a lane is judged by its own files', () => {
  it('gotransit is not required to produce a metrolinx-only component', () => {
    expect(
      declaredFiles(lanePrd('gotransit')),
      'gotransit must build a component that does not exist in its repo — unwinnable retry loop',
    ).not.toContain(METROLINX_ONLY);
  });

  it('upexpress is not either', () => {
    expect(declaredFiles(lanePrd('upexpress'))).not.toContain(METROLINX_ONLY);
  });

  it('metrolinx IS still required to produce it', () => {
    // The negative assertions above are satisfiable by returning nothing at all. This is the
    // paired positive: the scoping must narrow, not empty.
    expect(declaredFiles(lanePrd('metrolinx'))).toContain(METROLINX_ONLY);
  });

  it("the lane still gets its own real files — scoping did not gut the list", () => {
    const files = declaredFiles(lanePrd('gotransit'));
    expect(files.length, 'the gate would verify nothing at all').toBeGreaterThan(0);
    expect(files.sort()).toEqual([...GOTRANSIT].sort());
  });
});

describe('shapes without per-codeline data are unchanged', () => {
  it('a story with no perCodeline falls back to the flat list', () => {
    const prd = { stories: [{ id: 'AMSD-2041', codeline: 'gotransit', technicalNotes: { files: GOTRANSIT } }] };
    expect(declaredFiles(prd).sort()).toEqual([...GOTRANSIT].sort());
  });

  it('a single-codeline story with no .codeline stamp falls back to the flat list', () => {
    const prd = { stories: [{ id: 'AMSD-2041', technicalNotes: { files: GOTRANSIT } }] };
    expect(declaredFiles(prd).sort()).toEqual([...GOTRANSIT].sort());
  });

  it('a codeline with no entry in perCodeline falls back rather than verifying nothing', () => {
    // A lane the spec pass never produced a list for must not silently become "no deliverables",
    // which would pass the gate for a story that did nothing.
    const prd = lanePrd('some-new-codeline');
    expect(declaredFiles(prd).sort()).toEqual([...GOTRANSIT, METROLINX_ONLY].sort());
  });

  it('no technicalNotes at all yields an empty list without erroring', () => {
    expect(declaredFiles({ stories: [{ id: 'AMSD-2041' }] })).toEqual([]);
  });

  it('an empty per-codeline list is honoured, not treated as absent', () => {
    // Distinct from "no entry": an explicitly empty list means this lane declares nothing.
    const prd = {
      stories: [{
        id: 'AMSD-2041', codeline: 'gotransit',
        technicalNotes: { files: GOTRANSIT, perCodeline: { gotransit: { files: [] } } },
      }],
    };
    expect(declaredFiles(prd)).toEqual([]);
  });
});
