/**
 * The code-graph-detective runs BEFORE storyKind classification (spec-mode-runner.js:2381
 * documents this ordering deliberately — its findings ground the classifier). Its prompt
 * and profile were hardcoded to "you are investigating this bug ticket" / "SYMPTOM vs
 * CAUSE" regardless of kind, unlike SPEC_AGENT's own prompt (line ~2627), which already
 * branches defect ("find the FIX SITE") vs novel ("find the ATTACHMENT POINT — there is no
 * fix site, and inventing one produces a confident wrong answer").
 *
 * AMSD-2041 (storyKind: novel) got a detective prompt that told it to hunt for a "cause"
 * of a "bug" that was never there.
 *
 * Fix: a cheap, deterministic, zero-LLM-cost hint derived from Jira's own issueType field
 * — already trusted downstream for the SAME purpose (line 3273-3276, "anchoring
 * storyKind=defect... Jira ground truth"). This does not replace that later, authoritative
 * classification; it only steers the detective's OWN framing before that classification
 * exists.
 */
import { describe, it, expect } from 'vitest';

const SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8'
);

function extractFunctionBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `${name} not found in spec-mode-runner.js`).toBeGreaterThan(0);
  const end = SRC.indexOf('\n}', start) + 2;
  return SRC.slice(start, end);
}

describe('inferStoryKindHint — cheap, deterministic, no LLM call', () => {
  // Loaded in a real Node vm so this tests the ACTUAL function, not a reimplementation.
  const fnBody = extractFunctionBody('inferStoryKindHint');
  const mod: { inferStoryKindHint?: (story: unknown) => string } = {};
  // eslint-disable-next-line no-new-func
  new Function('mod', `${fnBody}\nmod.inferStoryKindHint = inferStoryKindHint;`)(mod);

  it('THE CASE: a Jira "Story" with no ACs hints novel, not defect', () => {
    expect(mod.inferStoryKindHint!({ issueType: 'Story', acceptanceCriteria: [] })).toBe('novel');
  });

  // DECLARED, NOT ASSUMED (2026-08-08): "Bug" was a literal in the engine. It is this Jira's
  // word; a tracker saying "Defect"/"Fault"/"Incident" silently classified every story as
  // novel, so defects lost causal tracing with no gate and no warning. The project declares
  // its own defect types now, and these cases declare them like a project would.
  it('a declared defect type hints defect', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'bug';
    try {
      expect(mod.inferStoryKindHint!({ issueType: 'Bug' })).toBe('defect');
    } finally { delete process.env.EPAM_DEFECT_ISSUE_TYPES; }
  });

  it('case-insensitive and tolerates the lowercase Jira field name too', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'bug';
    try {
      expect(mod.inferStoryKindHint!({ issuetype: 'bug' })).toBe('defect');
    } finally { delete process.env.EPAM_DEFECT_ISSUE_TYPES; }
  });

  it('with nothing declared, even a Bug is treated as new work — the safer contract', () => {
    delete process.env.EPAM_DEFECT_ISSUE_TYPES;
    expect(mod.inferStoryKindHint!({ issueType: 'Bug' })).toBe('novel');
  });

  it('an absent/unknown issueType defaults to novel, not a silent crash', () => {
    expect(mod.inferStoryKindHint!({})).toBe('novel');
  });

  it('a Task type hints novel (only Bug anchors defect, matching the downstream trust rule)', () => {
    expect(mod.inferStoryKindHint!({ issueType: 'Task' })).toBe('novel');
  });
});

describe('the detective prompt is steered by the hint, not hardcoded to bug framing', () => {
  const fnSrc = (() => {
    const start = SRC.indexOf('async function runCodeGraphDetective(');
    // Anchored on the function's OWN closing brace. It used to anchor on a line of PROMPT
    // TEXT ('CRITICAL REALITY ANCHOR'), which moved into the template on 2026-08-12 — the
    // slice then collapsed to '' and every assertion below passed nothing to match.
    const end = SRC.indexOf('\n}', start) + 2;
    return SRC.slice(start, end);
  })();

  it('calls inferStoryKindHint before building the prompt', () => {
    expect(fnSrc, 'the hint must be computed inside runCodeGraphDetective').toMatch(/inferStoryKindHint\(/);
  });

  it('the prompt template branches wording by the hint, not a bare "bug ticket" constant', () => {
    expect(
      fnSrc,
      'a hardcoded "You are investigating this bug ticket" line regardless of kind is the ' +
        'exact defect this fix removes',
    ).not.toMatch(/You are investigating this bug ticket/);
  });

  it('novel framing mentions there is no fix site, mirroring SPEC_AGENT\'s own wording', () => {
    // Asserted on the ARTEFACT the function produces, not on source text near it.
    const mod = require(require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
    expect(String(mod.detectivePrescription('novel'))).toMatch(/attachment point/i);
  });
});
