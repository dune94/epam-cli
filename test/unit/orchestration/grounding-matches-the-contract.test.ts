/**
 * THE GROUNDING CHECK MUST ASK FOR WHAT THE PROMPT ASKED FOR.
 *
 * The detective's contract now branches on story kind: a defect must quote the broken
 * expression (machine-verified against the file), a feature must not — there is nothing broken
 * to quote, and the novel prescription explicitly says leave `brokenLine` empty.
 *
 * The VALIDATOR was not branched. It computes:
 *
 *     const grounded = findings.filter((f) => f.evidenceVerified === true);
 *     if (grounded.length === 0) { … retry … }
 *
 * and `evidenceVerified` is true only when a quoted line is found in the named file. A correct
 * novel answer leaves it null for every finding, so `grounded.length === 0` ALWAYS, so the
 * answer is rejected as "UNGROUNDED" and re-tried three times before being passed through
 * flagged. Live 2026-08-08, AMSD-2041:
 *
 *     ⚠️ code-graph-detective answer is UNGROUNDED (attempt 1/3) — no finding quoted an
 *        existing broken expression at all — the diagnosis is not backed by real code
 *     ⚠️ … (attempt 2/3) …
 *
 * Three model calls per story to fail a check that cannot pass, and the answer that survives is
 * the one that gave up. This is the same defect as the prompt itself had, made while fixing it:
 * the demand was moved out of the instructions and left in the enforcement.
 *
 * A feature IS groundable — just not by quotation. Its grounding is PROVENANCE: every file it
 * names was returned by a tool and exists in the repository.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

/** A defect answer: quotes a line that was verified against the file. */
const QUOTED_VERIFIED = [{ file: 'src/a.ts', brokenLine: 'x === y', evidenceVerified: true, fileVerified: true }];
/** A defect answer whose quote is NOT in the file — a story about absent code. */
const QUOTED_FALSE = [{ file: 'src/a.ts', brokenLine: 'nope', evidenceVerified: false, fileVerified: true }];
/** A correct NOVEL answer: real files, no quoted line, exactly as the prompt instructs. */
const NOVEL_OK = [
  { file: 'src/services/client.ts', brokenLine: '', evidenceVerified: null, fileVerified: true },
  { file: 'src/hooks/useThing.ts', brokenLine: '', evidenceVerified: null, fileVerified: true },
];
/** A novel answer naming a file that does not exist — invented. */
const NOVEL_PHANTOM = [{ file: 'src/nope.ts', brokenLine: '', evidenceVerified: null, fileVerified: false }];

describe('the fixture is real', () => {
  it('the decision is exported', () => {
    expect(typeof spec.detectiveAnswerIsGrounded).toBe('function');
  });
});

describe('a DEFECT is grounded by quotation, as before', () => {
  it('a verified quote is grounded', () => {
    expect(spec.detectiveAnswerIsGrounded({ findings: QUOTED_VERIFIED, kind: 'defect' }).grounded).toBe(true);
  });

  it('a quote that is not in the file is NOT grounded', () => {
    const r = spec.detectiveAnswerIsGrounded({ findings: QUOTED_FALSE, kind: 'defect' });
    expect(r.grounded, 'a plausible story about absent code is not an answer').toBe(false);
  });

  it('a defect with no quote at all is NOT grounded — the check keeps its teeth', () => {
    expect(spec.detectiveAnswerIsGrounded({ findings: NOVEL_OK, kind: 'defect' }).grounded).toBe(false);
  });
});

describe('THE REGRESSION: a NOVEL answer is grounded by provenance', () => {
  it('real files with no quoted line ARE grounded', () => {
    const r = spec.detectiveAnswerIsGrounded({ findings: NOVEL_OK, kind: 'novel' });
    expect(
      r.grounded,
      'a correct feature answer is rejected as ungrounded and re-tried three times, because ' +
      'the validator still demands a quotation the prompt told it not to produce',
    ).toBe(true);
  });

  it('the grounding does not depend on evidenceVerified at all', () => {
    // Prompt and validator drifted apart twice. Pin the independence.
    const withNulls = NOVEL_OK.map((f) => ({ ...f, evidenceVerified: null }));
    expect(spec.detectiveAnswerIsGrounded({ findings: withNulls, kind: 'novel' }).grounded).toBe(true);
  });

  it('a named file that does not exist is NOT grounded — invention is still refused', () => {
    const r = spec.detectiveAnswerIsGrounded({ findings: NOVEL_PHANTOM, kind: 'novel' });
    expect(r.grounded).toBe(false);
    expect(r.reason).toMatch(/exist|invent|provenance/i);
  });

  it('a quoted line that IS verified also grounds a novel answer — it is not forbidden', () => {
    expect(spec.detectiveAnswerIsGrounded({ findings: QUOTED_VERIFIED, kind: 'novel' }).grounded).toBe(true);
  });
});

describe('edges', () => {
  it('no findings is never grounded, for either kind', () => {
    for (const kind of ['defect', 'novel']) {
      expect(spec.detectiveAnswerIsGrounded({ findings: [], kind }).grounded).toBe(false);
    }
  });

  it('an unknown kind is judged as novel — the safer contract', () => {
    expect(spec.detectiveAnswerIsGrounded({ findings: NOVEL_OK, kind: '' }).grounded).toBe(true);
  });

  it('the reason says which contract was applied, so a log line is diagnosable', () => {
    expect(spec.detectiveAnswerIsGrounded({ findings: NOVEL_PHANTOM, kind: 'novel' }).reason).toBeTruthy();
    expect(spec.detectiveAnswerIsGrounded({ findings: QUOTED_FALSE, kind: 'defect' }).reason).toBeTruthy();
  });
});

describe('the gate actually uses it — wiring, not just the helper existing', () => {
  const SRC = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the UNGROUNDED gate calls the kind-aware decision', () => {
    const i = SRC.indexOf('is UNGROUNDED (attempt');
    expect(i, 'the grounding gate is gone').toBeGreaterThan(-1);
    const near = SRC.slice(Math.max(0, i - 700), i);
    expect(near, 'the gate still decides grounding for itself').toMatch(/detectiveAnswerIsGrounded\(/);
  });

  it('the gate no longer filters on evidenceVerified to decide', () => {
    const i = SRC.indexOf('is UNGROUNDED (attempt');
    const near = SRC.slice(Math.max(0, i - 700), i);
    expect(
      near,
      'requiring a verified quote is exactly what made a correct feature answer unpassable',
    ).not.toMatch(/const grounded = findings\.filter/);
  });

  it('findings carry fileVerified, so provenance is checkable at all', () => {
    expect(SRC).toMatch(/fileVerified:/);
  });

  it('the kind passed to the gate is the same hint the prompt branched on', () => {
    const i = SRC.indexOf('detectiveAnswerIsGrounded({ findings, kind:');
    expect(SRC.slice(i, i + 80)).toMatch(/kind: _kindHint/);
  });
});
