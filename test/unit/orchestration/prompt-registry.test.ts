/**
 * Every prompt the pipeline sends is well-structured and free of another
 * project's specifics — and a NEW prompt cannot be added without both.
 *
 * Two live failures motivate this, both from prompts rather than code:
 *
 *   The pre-phase assessment carried seven worked examples from the travel-app
 *   project (node-fetch, vi.stubGlobal, CLI argv parsing). Run against the
 *   client's Next.js site it copied them as findings and told sast-sentinel to
 *   suppress every finding on four files that do not exist. It also assumed
 *   vitest where that repo runs jest — not merely foreign, factually false.
 *
 *   speckit answered in prose instead of JSON and the parse failed; discovery
 *   returned an empty response. Neither prompt declared an output contract the
 *   caller could validate, so "wrong shape" and "no answer" were indistinguishable
 *   from each other and from success.
 *
 * WHY EXTRACTION PRECISION IS THE WHOLE DESIGN. A first pass at this audit
 * sliced a fixed 5,000 characters after each "You are" and reported 17 prompts
 * carrying stack specifics and 25 with no output contract. Checked one by one,
 * essentially all were artifacts of the measurement:
 *
 *   - most "stack specifics" were COMMENTS in the surrounding script — one file
 *     contributed 62 hits, all documentation about a past Node/vitest incident;
 *   - most "no contract" hits merely NAMED a .json file ("read prd.json"), which
 *     says nothing about what the model should return;
 *   - two survivors were regex misses: a heredoc writes its skeleton with
 *     backslash-escaped quotes (`{\"restructure\": ...}`), and the detective's
 *     literal contains escaped backticks (\`explore\`) that truncated capture at
 *     1,379 of its characters — its schema sits past the cut.
 *
 * A registry test that measures the wrong region is worse than none: it
 * manufactures work and trains people to ignore it. So prompts are extracted by
 * their REAL boundaries — heredoc markers in shell, template literals in JS with
 * escape-spanning — comment lines are excluded, and the rules distinguish asking
 * for JSON from naming a file. Measured that way the pipeline's 29 prompts are
 * already clean; these tests keep the next one honest.
 *
 * The two rules:
 *   CONTRACT — a prompt whose answer is consumed programmatically must say what
 *              shape it wants, so a bad answer is detectable rather than
 *              silently mis-parsed.
 *   NO FOREIGN SPECIFICS — a worked example is something to COPY. Anything
 *              naming another project's tools, files or story IDs teaches this
 *              project's agents the wrong codebase.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

interface Prompt { file: string; body: string; }

function sources(): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (/\.(sh|js)$/.test(e.name)) out.push(p);
    }
  })(SCRIPTS);
  return out;
}

/**
 * Prompt bodies by their REAL boundaries.
 *  - shell: a heredoc whose content mentions "You are", bounded by its marker
 *  - js:    a template literal containing "You are", bounded by its backticks
 * Comment lines are dropped: a comment is not sent to the model.
 */
function prompts(): Prompt[] {
  const found: Prompt[] = [];
  for (const file of sources()) {
    if (/\/test\//.test(file)) continue;
    const src = readFileSync(file, 'utf8');

    for (const m of src.matchAll(/<<-?\s*'?"?([A-Z_][A-Z0-9_]*)'?"?\n/g)) {
      const marker = m[1];
      const start = m.index! + m[0].length;
      const endRel = src.slice(start).search(new RegExp(`^${marker}\\s*$`, 'm'));
      if (endRel < 0) continue;
      const body = src.slice(start, start + endRel);
      if (/You are\b/.test(body)) found.push({ file, body });
    }

    // `(?:[^`\\]|\\.)*` spans backslash-escaped backticks. A naive `[^`]*`
    // stops at the first \` — which cut the detective prompt at 1,379 chars and
    // hid the schema that follows.
    for (const m of src.matchAll(/`((?:[^`\\]|\\.)*You are\b(?:[^`\\]|\\.)*)`/g)) {
      found.push({ file, body: m[1] });
    }
  }
  // Strip comment lines — shell `#` and JS `//` at line start.
  return found.map((p) => ({
    ...p,
    body: p.body.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n'),
  }));
}

const ALL = prompts();
const rel = (f: string) => f.replace(SCRIPTS + '/', '');

describe('the registry finds real prompts', () => {
  it('extracts a meaningful number of them', () => {
    // Guards the extractor itself: if boundary matching breaks, every rule below
    // silently passes over an empty set.
    expect(ALL.length, 'prompt extraction found nothing — the rules below prove nothing')
      .toBeGreaterThan(10);
  });

  it('extracts bodies, not whole files', () => {
    const huge = ALL.filter((p) => p.body.length > 30000).map((p) => rel(p.file));
    expect(huge, `these captured far more than a prompt: ${huge.join(', ')}`).toEqual([]);
  });
});

describe('the rules themselves detect what they claim to', () => {
  // Every rule below currently passes because the prompts are clean. That is
  // indistinguishable from a rule that can never fail, so each is fired at a
  // prompt exhibiting exactly the defect it exists to catch.
  const ASKS = /(return|output|emit|respond|produce|reply|answer)[^.\n]{0,60}\bJSON\b/i;
  const SHAPE = /schema|Output format|raw JSON only|JSON only|strict JSON|\{\s*\\?"[a-zA-Z_]/;
  const FOREIGN = /skyscanner|rapidapi|\bSKY-\d{3}/i;

  it('flags a prompt that asks for JSON and declares no shape', () => {
    expect(ASKS.test('You are an analyst. Return JSON with your verdict.')).toBe(true);
    expect(SHAPE.test('You are an analyst. Return JSON with your verdict.')).toBe(false);
  });

  it('does NOT flag a prompt that merely names a .json file', () => {
    // The false positive that inflated the original count from 2 to 25.
    expect(ASKS.test('You are an analyst. Read orchestrations/prd.json first.')).toBe(false);
  });

  it('accepts an escaped skeleton as a declared shape', () => {
    // How a shell heredoc necessarily writes it.
    expect(SHAPE.test('respond with JSON {\\"restructure\\": true, \\"reason\\": \\"...\\"}')).toBe(true);
  });

  it('flags another project\'s vendor and story IDs', () => {
    expect(FOREIGN.test('e.g. process.env.SKYSCANNER_API_KEY')).toBe(true);
    expect(FOREIGN.test('story SKY-003 changed the same file')).toBe(true);
  });
});

describe('no prompt teaches another project\'s codebase', () => {
  it('names no other project\'s product, vendor or story IDs', () => {
    const FOREIGN = /skyscanner|rapidapi|\bSKY-\d{3}/i;
    const bad = ALL.filter((p) => FOREIGN.test(p.body))
      .map((p) => `${rel(p.file)}: "${(FOREIGN.exec(p.body) || [''])[0]}"`);
    expect([...new Set(bad)],
      `prompts carrying another project's specifics — an LLM with one concrete ` +
      `example and no concrete facts will copy it:\n  ${[...new Set(bad)].join('\n  ')}`)
      .toEqual([]);
  });

  it('supplies no worked example with a concrete import path', () => {
    // The mechanism, not the vocabulary: `vi.mock('./skyscanner/client')` is
    // copyable regardless of which project it names.
    const EXAMPLE = /e\.g\.\s*['"`]\.\.?\//;
    const bad = ALL.filter((p) => EXAMPLE.test(p.body)).map((p) => rel(p.file));
    expect([...new Set(bad)],
      `prompts give a concrete import path as an example: ${[...new Set(bad)].join(', ')}`)
      .toEqual([]);
  });
});

describe('a prompt whose answer is parsed declares its shape', () => {
  it('every JSON-consuming prompt states an output contract', () => {
    // If the caller parses it, the prompt must say what to produce — otherwise
    // prose and failure are indistinguishable, which is how run 7 and run 9 died.
    //
    // ASKS matches a prompt REQUESTING JSON back. A bare /json/ would match the
    // filename in "read prd.json", which tells the model nothing about its
    // answer — that false positive alone accounted for most of the original 25.
    const ASKS = /(return|output|emit|respond|produce|reply|answer)[^.\n]{0,60}\bJSON\b/i;
    // A shape is declared by schema wording OR an inline skeleton with quoted
    // keys. `\\?"` because a heredoc escapes its quotes: {\"restructure\": ...}.
    const SHAPE = /schema|Output format|raw JSON only|JSON only|strict JSON|\{\s*\\?"[a-zA-Z_]/;
    const bad = ALL
      .filter((p) => ASKS.test(p.body) && !SHAPE.test(p.body))
      .map((p) => rel(p.file));
    expect([...new Set(bad)],
      `these ask for JSON but never state the shape expected:\n  ${[...new Set(bad)].join('\n  ')}`)
      .toEqual([]);
  });
});
