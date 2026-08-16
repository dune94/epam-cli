/**
 * AC immutability at INGEST (AC/VC/TC design, 2026-07-24).
 *
 * Found live: AMSD-1820 has ZERO acceptance criteria in Jira. ac-gate auto-
 * elaborated 6 ACs from the description and synthesize-prd used those as the
 * story's acceptanceCriteria — so the "immutable ACs" were fabrications, re-
 * creating the exact AC-elaboration the VC layer exists to eliminate, one stage
 * upstream of the VC guard. Fix: for brownfield, the story's acceptanceCriteria
 * are the ticket's ORIGINAL ACs only (empty if the ticket has none); the
 * description feeds the VERIFICATION CRITERIA via openspec, and the detective
 * decides sufficiency — no human halt on sparse ACs.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SYNTH = join(ROOT, 'orchestrations/scripts/synthesize-prd-from-jira.js');
// The synthesizer has no built-in template: a built-in one lent every run another project's
// identity. This test is about AC provenance, so the template it supplies is anonymous.
const TEMPLATE = join(__dirname, '../../fixtures/prd/neutral-synthesis-template.json');
const ingestSrc = readFileSync(join(ROOT, 'orchestrations/scripts/ingest-jira-tickets.sh'), 'utf8');
const NODE = process.env.NODE_BIN || 'node';

// One classification: a ticket with NO original ACs, but ac-gate fabricated 3.
const CLASSIFICATIONS = [{
  jiraKey: 'AMSD-1820',
  storyId: 'AMSD-1820',
  title: '[Mozio] promo amount not shown for return trip',
  codeline: 'cdts',
  verdict: 'enrichable',
  issueType: 'Story',
  originalAcs: [], // the ticket has none
  enrichedAcs: [   // ac-gate fabricated these from the description
    'The system displays the promo discount for both legs.',
    'The discount is calculated per segment.',
    'No regression for outbound.',
  ],
}];

function synth(env: Record<string, string>): any {
  const dir = mkdtempSync(join(tmpdir(), 'synth-ac-'));
  try {
    const cf = join(dir, 'classifications.json');
    const out = join(dir, 'prd.json');
    writeFileSync(cf, JSON.stringify(CLASSIFICATIONS));
    execFileSync(NODE, [SYNTH, '--classifications', cf, '--out', out, '--template', TEMPLATE], {
      encoding: 'utf8',
      env: { ...process.env, JIRA_DEFAULT_CODELINE: 'cdts', ...env },
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('synthesize-prd — brownfield ACs are the ticket original, never ac-gate fabrications', () => {
  it('brownfield: a no-AC ticket yields EMPTY acceptanceCriteria (not the fabricated enrichedAcs)', () => {
    const prd = synth({ EPAM_BROWNFIELD: '1' });
    const story = prd.stories.find((s: any) => /AMSD-1820/.test(s.id));
    expect(story).toBeTruthy();
    expect(story.acceptanceCriteria).toEqual([]); // immutable ticket intent — none
    // the fabricated per-segment AC must NOT have leaked into acceptanceCriteria
    expect(JSON.stringify(story.acceptanceCriteria)).not.toContain('per segment');
  });

  it('greenfield (no EPAM_BROWNFIELD): keeps the enriched behavior (defining new behavior is the job)', () => {
    const prd = synth({});
    const story = prd.stories.find((s: any) => /AMSD-1820/.test(s.id));
    expect(story.acceptanceCriteria.length).toBe(3); // enriched ACs used
  });
});

describe('ingest — brownfield does NOT halt on sparse/no ACs (defers to the detective sufficiency gate)', () => {
  it('the insufficient-halt is bypassed under EPAM_BROWNFIELD (no human in the loop)', () => {
    expect(ingestSrc).toMatch(/EPAM_BROWNFIELD:-0.*=.*"1".*INSUFFICIENT_COUNT/s);
    expect(ingestSrc).toMatch(/brownfield proceeds.*ACs stay immutable.*VCs derived from the description.*detective decides sufficiency/s);
  });
});
