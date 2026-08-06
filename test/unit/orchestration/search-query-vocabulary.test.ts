/**
 * The brownfield search query is DERIVED and EVIDENCE-CHECKED, not filtered by a list.
 *
 * WHAT WAS WRONG
 * --------------
 * buildBrownfieldSearchQuery seeded the code-graph detective's very first `explore` — the
 * query that starts the entire chain (fix sites -> manifest -> ACs -> VCs). It built that
 * query from the story TITLE ONLY:
 *
 *   - `description` was never read, and in brownfield the description IS the contract
 *     (the AC gate says so: "VCs are derived from the description").
 *   - `acceptanceCriteria` WAS read, and is empty by design in brownfield.
 *   - `technicalNotes` does not exist yet at this point in the flow.
 *
 * Live (run 20260806T134550Z) the detective was seeded with:
 *
 *     go up mx live preview of content in cms
 *
 * Three tokens are a bracketed brand tag. `of` and `in` are in the stopword list and
 * survived anyway, because the filter required BOTH `length > 1` AND absence from the set.
 * The detective found the right files by reading code, not because of this query.
 *
 * WHY A LIST — OR NO LIST — BOTH FAIL
 * -----------------------------------
 * A hardcoded stopword list is forbidden and was removed. But simply deleting the filter is
 * WORSE, and this is the subtle part: BM25/IDF demotes terms that are COMMON in the corpus
 * and AMPLIFIES terms that are RARE. `mx` appears in almost no file, so IDF scores it as a
 * top discriminator. Frequency statistics cannot tell "rare and meaningful" from "rare and
 * meaningless" — that needs judgement.
 *
 * So the terms are derived by the guard-vocabulary agent AND verified against the CodeGraph
 * index: a candidate that resolves to no symbol is noise however rare it is. Judgement to
 * propose, evidence to confirm, determinism to apply.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildBrownfieldSearchQuery } = spec;

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

/** The real ticket that exposed this, verbatim. */
const STORY: any = {
  id: 'T-1',
  title: '[GO, UP, MX] Live Preview of Content in CMS',
  description:
    'AS a Content Author, I WANT to preview draft entries in CMS, SO THAT I can see how ' +
    'content will be shown on the website. Limitation: might not be possible to preview ' +
    'protected pages.',
  acceptanceCriteria: [],
};

describe('the query is built from everything the story actually carries', () => {
  it('THE DEFECT: the description reaches the query', () => {
    const q = buildBrownfieldSearchQuery(STORY);
    expect(
      q,
      'the description is the only substantive content a brownfield ticket has, and it was ignored',
    ).toMatch(/draft/);
  });

  it('the title still reaches the query', () => {
    expect(buildBrownfieldSearchQuery(STORY)).toMatch(/preview/);
  });

  it('acceptance criteria are included when a story has them (greenfield path)', () => {
    const q = buildBrownfieldSearchQuery({ ...STORY, acceptanceCriteria: ['the tariff schedule recalculates'] });
    expect(q).toMatch(/tariff/);
  });

  it('does not truncate the description away — the cap must not reintroduce starvation', () => {
    const long = 'alpha '.repeat(200) + 'zebrafish';
    const q = buildBrownfieldSearchQuery({ ...STORY, description: long });
    expect(q, 'a distinctive term at the end of a long description was cut').toMatch(/zebrafish/);
  });

  it('never returns empty, even for a degenerate story', () => {
    expect(buildBrownfieldSearchQuery({ id: 'x', title: 'Fix it' }).length).toBeGreaterThan(0);
  });
});

describe('term selection is derived + evidence-checked, never a list', () => {
  it('a supplied vocabulary decides what survives — the code decides nothing', () => {
    const q = buildBrownfieldSearchQuery(STORY, {
      blacklist: [{ term: 'go', reason: 'brand tag' }, { term: 'up', reason: 'brand tag' },
                  { term: 'mx', reason: 'brand tag' }],
      whitelist: [],
    });
    expect(q.split(/\s+/), 'a brand tag reached the query and IDF will amplify it as rare')
      .not.toEqual(expect.arrayContaining(['go', 'up', 'mx']));
    expect(q, 'the real capability terms were lost with the tags').toMatch(/preview/);
  });

  it('the SAME story keeps those terms under a vocabulary that does not exclude them', () => {
    const q = buildBrownfieldSearchQuery(STORY, { blacklist: [], whitelist: [] });
    expect(q).toMatch(/\bmx\b/);
  });

  it('with no vocabulary supplied the query is unfiltered — the caller decides, not this function', () => {
    expect(buildBrownfieldSearchQuery(STORY)).toMatch(/\bmx\b/);
  });
});

describe('no hardcoded vocabulary remains at this seam', () => {
  const fn = SRC.slice(SRC.indexOf('function buildBrownfieldSearchQuery'),
                       SRC.indexOf('\n}', SRC.indexOf('function buildBrownfieldSearchQuery')));

  it('the stopword set is gone from the query builder', () => {
    expect(fn).not.toMatch(/SYMPTOM_STOPWORDS/);
  });

  it('no arbitrary slice of the acceptance criteria', () => {
    expect(fn, 'a picked number silently discarded input to the query that finds the fix site')
      .not.toMatch(/acceptanceCriteria[^\n]*\.slice\(0,\s*\d/);
  });

  it('the length heuristic is gone — it dropped nothing useful and let function words through', () => {
    expect(fn).not.toMatch(/w\.length > 1/);
  });
});

describe('the vocabulary agent is given the tools to VERIFY a term, not just guess', () => {
  it('the seam passes a repo path and the CodeGraph query tool', () => {
    expect(SRC).toMatch(/seam: 'search-query'/);
    expect(SRC, 'the agent cannot check a candidate term against the real index')
      .toMatch(/codegraphTool|codegraph-agent-query\.sh/);
  });

  it('the agent is told the ranking behaviour it is feeding', () => {
    // Without this it optimises for the wrong thing: IDF AMPLIFIES rare terms, so a
    // rare-but-meaningless token is the failure mode, not a win.
    expect(SRC).toMatch(/amplif/i);
  });

  it('the guard-vocabulary agent profile grants it the query tool', () => {
    const profiles = JSON.parse(readFileSync(
      join(__dirname, '../../../orchestrations/agents/profiles.canonical.json'), 'utf8'));
    const p = profiles['guard-vocabulary-agent'];
    expect(p, 'the agent profile is missing').toBeTruthy();
    expect(p, 'the profile never tells the agent it can verify a term against the index')
      .toMatch(/codegraph|verify .*term|index/i);
  });
});
