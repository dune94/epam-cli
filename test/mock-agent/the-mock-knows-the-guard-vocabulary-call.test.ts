/**
 * THE MOCK ANSWERS THE GUARD-VOCABULARY CALL AS GUARD VOCABULARY.
 *
 * Rehearsal 2026-10-08 (AMSD-2974, real-estate copy): the guard-vocabulary prompt carries its own template only partly
 * (2 of 4 fixed segments), a guard-vocabulary fragment in full, and a shared spec-authoring-rules fragment in full that
 * the ac-elaboration seam declares. Counting only fully present templates gave each seam one vote; the earlier start
 * won and the call was answered as ac-elaboration — no vocabulary, the spec pass failed, and the rehearsal could not
 * get past the spec. The real model answers this call fine (live run 9).
 *
 * EXECUTED: the mock's Declarations.identify on the real request the pipeline sent (frozen), and on the detective
 * case the earlier rule fixed (2026-10-06), which must still hold.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Declarations } from './declarations';

const ORCH = join(__dirname, '../../orchestrations');
const d = new Declarations(ORCH);
const seam = (text: string) => { const id = d.identify(text, ['brownfield', 'multi-codeline']); return id ? d.seamOf(id.template, ['brownfield', 'multi-codeline']) : ''; };

describe('the mock recognises the seam that called', () => {
  it('the guard-vocabulary request (real, frozen) is the guard-vocabulary seam', () => {
    const text = readFileSync(join(__dirname, '../fixtures/mock-agent/guard-vocabulary-request-20261008.txt'), 'utf8');
    expect(seam(text)).toBe('guard-vocabulary');
  });
});
