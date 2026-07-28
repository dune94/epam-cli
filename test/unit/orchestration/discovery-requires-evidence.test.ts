/**
 * A codeline must be selected on evidence, not on a hunch.
 *
 * Live AMSD-2041 ("[GO, UP, MX] Live Preview of Content in CMS"), 2026-07-28.
 * Discovery returned four codelines. Three were grounded:
 *
 *   gotransit  "Ticket component GO maps to the GO Transit website"
 *   upexpress  "Ticket component UP maps to the UP Express website"
 *   metrolinx  "Ticket component MX maps to the Metrolinx website"
 *
 * The fourth was not:
 *
 *   c365       "second-ranked candidate LIKELY SERVING AS the content
 *               management backend for the Intake & Planning component"
 *
 * c365 has no package.json. It contains Functional/ and Integration/ test
 * assets, sonar-project.properties and a .db file, and its latest commit is an
 * Azure Data Factory pipeline change. It is a data-integration repo, not a CMS
 * and not a website. The ticket is front-end live preview of draft content.
 *
 * The prompt CAUSED this. Rule 3 said: "never omit a candidate just because you
 * are uncertain, since uncertainty alone is not a reason to return fewer repos."
 * That was written to stop discovery converging on one repo, and it over-
 * corrected into an instruction to include what cannot be justified. Its
 * evidence was partly the repo's own SCORE RANK — circular, since the ranking is
 * what discovery is meant to adjudicate.
 *
 * Under MC-1 a wrong pick is load-bearing rather than merely wasteful: a story
 * completes only when EVERY declared lane completes, and partial coverage fails
 * the run. So a detective correctly finding nothing to change in an irrelevant
 * repo FAILS THE WHOLE STORY.
 *
 * The fix is structural, not a word-list: each selection must carry an
 * `evidence` field naming what grounds it, and a selection without one is
 * rejected deterministically. Keyword-matching hedge words ("likely",
 * "probably") would be unmaintainable and trivially evaded by rephrasing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DISCOVERY = join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js');
const src = readFileSync(DISCOVERY, 'utf8');

function prompt(): string {
  const i = src.indexOf('function buildDiscoveryPrompt');
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j > i ? j : src.length);
}

describe('the prompt demands evidence per selection', () => {
  it('requires an evidence field in the output shape', () => {
    expect(prompt(), 'selections carry only prose, so an ungrounded pick is unfilterable')
      .toMatch(/"evidence"/);
  });

  it('no longer tells the agent to include what it cannot justify', () => {
    // The exact sentence that produced the c365 lane.
    expect(prompt(),
      'the prompt still instructs the agent never to omit an uncertain candidate')
      .not.toMatch(/uncertainty alone is not a reason to return fewer repos/i);
  });

  it('tells it what to do with a candidate it cannot ground', () => {
    // Silence is not the alternative to guessing — the ambiguity is real
    // information (here: which repo "Intake & Planning" means) and belongs in
    // front of a human rather than being resolved by a coin flip.
    expect(prompt(), 'an ungrounded candidate has nowhere to go but the selection list')
      .toMatch(/unsure|cannot ground|not selected/i);
  });

  it('forbids using the candidate\'s own score as evidence', () => {
    // Circular: the ranking is what discovery exists to adjudicate. c365's
    // reason cited "second-ranked candidate".
    expect(prompt(), 'rank can still be offered as justification')
      .toMatch(/rank is not evidence|not.*evidence.*rank|score.*not.*evidence/i);
  });
});

describe('an ungrounded selection is rejected deterministically', () => {
  const CHECK = 'dropUngroundedCodelines';

  it('filters selections lacking evidence rather than trusting the prose', () => {
    // Prompt wording alone has repeatedly failed in this codebase — the
    // detective was told "HARD LIMIT: 6 tool calls" and used 25. The rule needs
    // a mechanism behind it.
    expect(src.indexOf(`function ${CHECK}`), 'no code-level evidence check exists')
      .toBeGreaterThan(-1);
    expect(src, 'the check is defined but never applied to the parsed response')
      .toMatch(new RegExp(`return ${CHECK}\\(|= ${CHECK}\\(`));
  });

  it('keys on the evidence field, not on hedge words', () => {
    // A "likely|probably|may be" blocklist is unmaintainable and evaded by
    // rephrasing. The requirement is positive: say what grounds the pick.
    const body = src.slice(src.indexOf(`function ${CHECK}`), src.indexOf(`function ${CHECK}`) + 1800);
    expect(body, 'the check does not read an evidence field').toMatch(/\.evidence/);
    expect(body, 'it degenerated into a hedge-word blocklist').not.toMatch(/likely\s*\|/i);
  });

  it('reports what it dropped instead of silently shrinking the set', () => {
    // Dropping a codeline silently is the mirror of adding one silently: the
    // operator must see that "Intake & Planning" could not be resolved.
    const body = src.slice(src.indexOf(`function ${CHECK}`), src.indexOf(`function ${CHECK}`) + 1800);
    expect(body, 'an ungrounded codeline is discarded with no signal').toMatch(/warn\(/);
  });

  it('never empties the selection, which would abort ingest', () => {
    // Zero codelines kills the run outright — a worse outcome than proceeding
    // with a visibly unverified pick.
    const body = src.slice(src.indexOf(`function ${CHECK}`), src.indexOf(`function ${CHECK}`) + 1800);
    expect(body, 'a fully-unevidenced response would leave zero codelines')
      .toMatch(/!kept\.length|kept\.length === 0/);
  });
});
