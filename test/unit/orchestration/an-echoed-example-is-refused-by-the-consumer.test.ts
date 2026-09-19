/**
 * AN ECHOED EXAMPLE IS REFUSED BY THE CONSUMER, NOT ONLY NOTED BY THE VALIDATOR.
 *
 * regintel 20260919T141354Z, scaffold spec pass: openspec answered REGI-001 with the prompt's own
 * example — `{"notes":"...","acceptanceCriteria":["..."],"description":"...","title":"...",
 * "splitStories":[{ }]}` (recorded in REGI-001-openspec-spec.log). The shared validator
 * detected it ("field notes is the prompt example's placeholder") — and the tag-parse seam then
 * returned the payload anyway: `return v.fatal ? null : parsed`, and an echo is not fatal. The
 * runner split REGI-001 into a child titled "... (Spec Split 1)" with description "..." and
 * AC "...", marked the parent "Delegated", and the scaffold writer was told to WRITE dial/,
 * .env.example and manifest.md with no trace of the authored "copy these unchanged from the
 * read-only source repo". It authored stubs; every core story then failed on them.
 *
 * The diagnostic-not-fatal policy is for an UNPROVEN SHAPE validator. An echoed example is not
 * a shape question: it is no answer in a valid shape, and config/answer-placeholders.json's own
 * rationale says it must be refused so the seam's retry, ladder and self-heal get their turn.
 * The recorded reply is replayed through the real seam.
 */

import { describe, it, expect, beforeAll } from 'vitest';

let runner: any;
let validator: any;
beforeAll(() => {
  process.env.SPEC_MODE_NO_MAIN = '1';
  process.env.EPAM_BROWNFIELD = '';
  delete process.env.EPAM_SCHEMA_STRICT;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  runner = require('../../../orchestrations/scripts/spec-mode-runner.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  validator = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
});

// Verbatim from the run's REGI-001-openspec-spec.log.
const RECORDED = '<SPEC_AGENT>{"storyId":"REGI-001","agent":"openspec","notes":"...","acceptanceCriteria":["..."],"description":"...","title":"...","splitStories":[{ }]}</SPEC_AGENT>';
const REAL = '<SPEC_AGENT>{"storyId":"REGI-001","agent":"openspec","notes":"scaffold","acceptanceCriteria":["dial/client.py is byte-identical to the source repo copy"],"description":"Create the skeleton; FIRST copy dial/ unchanged.","title":"Scaffold"}</SPEC_AGENT>';

describe('the validator marks an echoed example as a refusal, not a warning', () => {
  it('is fatal without EPAM_SCHEMA_STRICT', () => {
    const v = validator.validateTaggedOutput('SPEC_AGENT', JSON.parse(RECORDED.replace(/<\/?SPEC_AGENT>/g, '')));
    expect(v.ok).toBe(false);
    expect(v.fatal, 'an echo that is not fatal flows through the consumer as an answer').toBe(true);
  });
});

describe('THE DEFECT: the tag-parse seam handed the echoed example through', () => {
  it('returns null for the recorded reply — no payload for the runner to split on', () => {
    const parsed = runner.extractTaggedJson(RECORDED, 'SPEC_AGENT');
    expect(parsed, 'the raw extractor should still parse it — the refusal is the validator\'s').toBeTruthy();
    const out = runner._validatedOrNull(parsed, 'SPEC_AGENT', 'spec-agent');
    expect(out).toBeNull();
  });

  it('still returns a real answer unchanged', () => {
    const parsed = runner.extractTaggedJson(REAL, 'SPEC_AGENT');
    const out = runner._validatedOrNull(parsed, 'SPEC_AGENT', 'spec-agent');
    expect(out).toEqual(parsed);
  });

  it('a genuine shape mismatch stays diagnostic — the unproven-validator policy is untouched', () => {
    // A field of the wrong type is a shape question; that path keeps warning and flowing.
    const odd = JSON.parse(REAL.replace(/<\/?SPEC_AGENT>/g, ''));
    odd.acceptanceCriteria = 'not an array';
    const out = runner._validatedOrNull(odd, 'SPEC_AGENT', 'spec-agent');
    expect(out).toEqual(odd);
  });
});

describe('brownfield is judged the same way', () => {
  it('an echoed brownfield answer is refused too', () => {
    process.env.EPAM_BROWNFIELD = '1';
    try {
      const parsed = runner.extractTaggedJson(RECORDED, 'SPEC_AGENT');
      expect(runner._validatedOrNull(parsed, 'SPEC_AGENT', 'spec-agent')).toBeNull();
    } finally { process.env.EPAM_BROWNFIELD = ''; }
  });

  it('a real brownfield answer without acceptanceCriteria is accepted, as before', () => {
    process.env.EPAM_BROWNFIELD = '1';
    try {
      const bf = { storyId: 'AMSD-1919', agent: 'openspec', notes: 'defect', verificationCriteriaDetail: [{ criterion: 'the promo amount renders in the confirmation email', observer: 'end user', surface: 'the rendered email', setup: '' }] };
      expect(runner._validatedOrNull(bf, 'SPEC_AGENT', 'spec-agent')).toEqual(bf);
    } finally { process.env.EPAM_BROWNFIELD = ''; }
  });
});
