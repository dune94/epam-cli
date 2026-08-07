/**
 * VC (Verification Criteria) layer — step 1 of the AC/VC/TC design (2026-07-24).
 *
 * Closes the AC-quality gap by SEPARATION: acceptanceCriteria become the immutable
 * ticket intent (never elaborated / never mechanism-injected), and openspec-
 * brownfield instead produces a "verificationCriteria" layer — observable checks
 * derived from AC ∪ description, mechanism-forbidden. VC is persisted onto the
 * story so it reaches the PRD (observability) and downstream agents.
 *
 * Applies to ALL brownfield stories (bugs + features); greenfield is untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildBrownfieldArchaeologyBlock, normalizeVerificationCriteria } = spec;
const specSrc = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

describe('openspec-brownfield produces a VC layer, ACs immutable', () => {
  const bf = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });

  it('greenfield gets neither (VC is brownfield-only)', () => {
    const gf = buildBrownfieldArchaeologyBlock({});
    expect(gf.archaeologyBlock).toBe('');
    expect(gf.schemaLine).toBe('');
  });

  it('instructs: copy ACs verbatim, produce verificationCriteria from AC ∪ description', () => {
    expect(bf.archaeologyBlock).toMatch(/IMMUTABLE ticket intent/);
    expect(bf.archaeologyBlock).toMatch(/PRODUCE a "verificationCriteria" array/);
    expect(bf.archaeologyBlock).toMatch(/derived from the acceptance criteria AND the description/);
    // SUPERSEDED 2026-08-06. The instruction used to name acceptance criteria and the
    // description as the sources of verification, and to say "lean on the description when
    // the ACs are sparse or missing". A brownfield ticket has NO acceptance criteria — the AC
    // gate skips them by design — so this sent the model to the two thinnest fields in the
    // prompt while 4KB of vendor documentation sat above it unnamed. Sources are now the ones
    // the story actually has; pass hasAcceptanceCriteria to get the AC wording back.
    const withAcs = require('../../../orchestrations/scripts/spec-mode-runner.js')
      .buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' }, { hasAcceptanceCriteria: true });
    expect(withAcs.archaeologyBlock).toMatch(/acceptanceCriteria/);
    // `bf` above is built with no opts, which means "this story HAS acceptance criteria" —
    // the greenfield default. The brownfield case must be asked for explicitly.
    const noAcs = require('../../../orchestrations/scripts/spec-mode-runner.js')
      .buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' }, { hasAcceptanceCriteria: false });
    expect(noAcs.archaeologyBlock, 'a story with no ACs must not be told about ACs').not.toMatch(/acceptance criteria/i);
  });

  it('forbids mechanism in a VC (the guard the AC-quality problem needs)', () => {
    // Now sourced from the shared VC_OBSERVABILITY_RULES constant (producer==reviewer).
    expect(bf.archaeologyBlock).toMatch(/prescribes HOW to implement/);
    expect(bf.archaeologyBlock).toMatch(/WHAT AN END USER OR TESTER OBSERVES/);
  });

  it('schema exposes verificationCriteria + vcSource (provenance for the sparse-AC case)', () => {
    expect(bf.schemaLine).toMatch(/"verificationCriteria":\["<observable check/);
    expect(bf.schemaLine).toMatch(/"vcSource":"acceptance\|description\|both"/);
  });
});

describe('normalizeVerificationCriteria', () => {
  it('keeps non-empty trimmed strings, drops blanks/non-strings', () => {
    expect(normalizeVerificationCriteria({ verificationCriteria: ['  a ', '', 'b', 5, null, '  '] })).toEqual(['a', 'b']);
  });
  it('returns [] for a missing/invalid array', () => {
    expect(normalizeVerificationCriteria({})).toEqual([]);
    expect(normalizeVerificationCriteria({ verificationCriteria: 'x' })).toEqual([]);
    expect(normalizeVerificationCriteria(null)).toEqual([]);
  });
});

describe('VC is persisted onto the story (→ PRD, for observability)', () => {
  it('sets story.verificationCriteria + story.vcSource in the brownfield merge block', () => {
    expect(specSrc).toMatch(/story\.verificationCriteria = enforced\.vc/);
    expect(specSrc).toMatch(/story\.vcSource = /);
    expect(specSrc).toMatch(/verification criteria persisted \(source:/);
  });
});
