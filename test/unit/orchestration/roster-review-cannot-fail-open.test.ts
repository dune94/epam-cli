/**
 * A REVIEW THAT DID NOT RUN IS NOT A CLEAN REVIEW.
 *
 * The roster reviewer is the only check between a generated brief and an implementer
 * inheriting it whole. On 2026-08-08 it returned COMPLETELY EMPTY output — 47KB of prompt in,
 * 10 bytes out — and the roster reached the operator pause labelled `sound`, unreviewed.
 *
 * The collapse was two lines:
 *
 *     const raw = (payload && Array.isArray(payload.findings)) ? payload.findings : [];
 *     const verdict = findings.length ? 'defects_found' : 'sound';
 *
 * A null payload became an empty finding list, and an empty finding list is what a genuine
 * clean review looks like. "Produced nothing" and "found nothing wrong" were the same value.
 *
 * Deriving the verdict from the findings rather than taking the model's word for it is right
 * and stays. What was missing is a third state. There is already a guard for this — its
 * comment reads "A review that cannot run must not read as 'no defects' — that is the
 * fail-open shape" — but it only catches a THROWN error, and runAgentForJson returns null on
 * unparseable output instead of throwing, so it never fired.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionProject, cleanupProvisioned } from '../../support/provisioned-project';

// A SEAM PROMPT RENDERS FROM THE PROJECT'S COPY, SO THIS FILE SUPPLIES A PROJECT.
//
// prompt-library takes a seam-declared prompt only from <project>/prompts and refuses to execute
// a template — a project without a copy is a provisioning defect that must surface as one. No
// project in a fresh checkout has generated prompts, so every case here failed on that refusal
// rather than on what it asserts. The temp project is provisioned by COPYING the template, the
// way topology-router's harness does: specialisation is the mint's job, not a test's.
beforeAll(() => { process.env.EPAM_PROJECT_CONFIG_DIR = provisionProject(['roster-review']); });
afterAll(() => { delete process.env.EPAM_PROJECT_CONFIG_DIR; cleanupProvisioned(); });


const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const MINTED = [
  { name: 'some-engineer', kind: 'implementer', codeline: '*' },
  { name: 'alpha-investigator', kind: 'investigator', codeline: 'alpha' },
];
const CODELINES = [{ name: 'alpha', path: '/estate/alpha' }];

/** A runner that emits exactly the given raw text as its whole response. */
function runnerEmitting(raw: string) {
  const dir = mkdtempSync(join(tmpdir(), 'review-run-')); dirs.push(dir);
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > /dev/null\ncat <<'ANSWER'\n${raw}\nANSWER\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[] };
}

async function review(raw: string) {
  const dir = mkdtempSync(join(tmpdir(), 'review-log-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  // THE REVIEWER'S OWN BRIEF, FROM THE CANONICAL SOURCE.
  //
  // reviewRoster reads profiles['roster-reviewer'] and passes it as __PERSONA__ with no default,
  // unlike every sibling field which carries a "- (none ...)" fallback. Empty therefore means the
  // brief never arrived, and the prompt layer refuses rather than rendering a blank section for
  // an agent to answer about. The fixture supplied briefs for the MINTED agents only, so the
  // reviewer itself had none and every case failed on the refusal. Read from the canonical
  // roster rather than written here: a brief invented in a test proves the test's own text.
  const canonicalProfiles = JSON.parse(readFileSync(
    join(__dirname, '../../../orchestrations/agents/profiles.json'), 'utf8'));
  expect(canonicalProfiles['roster-reviewer'],
    'the canonical roster declares no roster-reviewer brief — reviewRoster cannot render at all')
    .toBeTruthy();
  writeFileSync(profilesPath, JSON.stringify({
    ...Object.fromEntries(MINTED.map((m) => [m.name, 'a brief '.repeat(30)])),
    'roster-reviewer': canonicalProfiles['roster-reviewer'],
  }));
  delete process.env.SPEC_MODE_PROVIDER;
  return spec.reviewRoster({
    promptExec: runnerEmitting(raw), minted: MINTED, codelines: CODELINES,
    profiles: JSON.parse(readFileSync(profilesPath, 'utf8')),
    logDir: dir, repoPath: dir,
  });
}

const CLEAN = '<ROSTER_REVIEW>{"findings":[]}</ROSTER_REVIEW>';

describe('the fixture is real', () => {
  it('a genuine clean review still reports sound', async () => {
    const r = await review(CLEAN);
    expect(r.verdict).toBe('sound');
    expect(r.findings).toEqual([]);
    expect(r.reviewed).toBe(2);
  }, 60_000);

  it('a review that finds a defect still reports it', async () => {
    const r = await review('<ROSTER_REVIEW>' + JSON.stringify({
      findings: [{ agent: 'some-engineer', claim: 'c', checked: 'k', found: 'f', severity: 'blocking' }],
    }) + '</ROSTER_REVIEW>');
    expect(r.verdict).toBe('defects_found');
    expect(r.findings.length).toBe(1);
  }, 60_000);
});

describe('THE DEFECT: a review that produced nothing must not read as clean', () => {
  it.each([
    ['completely empty output — the live 2026-08-08 case', ''],
    ['whitespace only', '   \n  '],
    ['prose instead of the tag', '# Roster Review\n\nThe roster looks reasonable to me.'],
    ['the tag with unparseable content', '<ROSTER_REVIEW>not json at all</ROSTER_REVIEW>'],
    ['valid JSON of the wrong shape', '<ROSTER_REVIEW>{"verdict":"sound"}</ROSTER_REVIEW>'],
  ])('%s does not report sound', async (_label, raw) => {
    const r = await review(raw);
    expect(
      r.verdict,
      'an unreviewed roster is labelled sound and reaches implementers unchecked',
    ).not.toBe('sound');
    expect(r.verdict).toBe('review_failed');
  }, 60_000);

  it('the failure is stated, so the operator can tell it apart from a pass', async () => {
    const r = await review('');
    expect(String(r.error || '')).toMatch(/\w/);
    expect(r.reviewed).toBe(0);
  }, 60_000);

  it('a failed review reports no findings rather than inventing them', async () => {
    const r = await review('');
    expect(r.findings).toEqual([]);
  }, 60_000);
});

describe('nothing to review is not the same as a failed review', () => {
  it('an empty roster is NOT settled — it owes a review the moment it gains an agent', async () => {
    // THIS ASSERTED THE FAIL-OPEN THIS FILE EXISTS TO PREVENT.
    //
    // It expected 'sound' for an empty roster. reviewRoster answers 'nothing_to_review', and
    // rosterReviewIsRequired deliberately groups that with 'not_run' and 'review_failed':
    // "an empty roster owes a review the moment it gains an agent. Treating it as settled is
    // how a vacuous pass returns by the back door." Calling it sound would let a roster reach
    // the operator labelled clean with nothing having checked it — the live 2026-08-08 case.
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const rosterLib = require('../../../orchestrations/scripts/lib/agent-roster.js');
    const r = await spec.reviewRoster({
      promptExec: runnerEmitting(CLEAN), minted: [], codelines: CODELINES,
      profiles: {}, logDir: undefined, repoPath: '',
    });
    expect(r.verdict).toBe('nothing_to_review');
    expect(r.reviewed).toBe(0);
    expect(r.findings).toEqual([]);
    // The distinction that matters: nothing to review is not a FAILED review, but it is not a
    // settled one either. The engine must still require one.
    expect(rosterLib.rosterReviewIsRequired({ verdict: r.verdict }),
      'an empty roster was treated as settled — the vacuous pass is back').toBe(true);
  }, 60_000);
});
