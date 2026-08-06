/**
 * The code-graph-detective's PROFILE (orchestrations/agents/profiles.json and .original —
 * both restored fresh each run, per memory: tier3-*-run.sh restores from .original, not
 * .canonical) told the agent it was "given a bug ticket" and to find "the CAUSE, not the
 * symptom" — regardless of whether the story is a defect or genuinely new work. Fixed
 * 2026-08-05 alongside the per-call hint in runCodeGraphDetective's prompt
 * (detective-storykind-hint.test.ts covers that half).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'orchestrations/agents/profiles.json',
  'orchestrations/agents/profiles.json.original',
];

describe.each(FILES)('%s — code-graph-detective profile', (relPath) => {
  const profile = JSON.parse(readFileSync(join(__dirname, '../../../', relPath), 'utf8'))['code-graph-detective'];

  it('exists and is non-empty', () => {
    expect(profile).toBeTruthy();
  });

  it('THE BUG: no longer hardcodes "given a bug ticket" as the sole framing', () => {
    expect(profile).not.toMatch(/given a bug ticket/i);
  });

  it('explicitly covers NOVEL work, not just defects', () => {
    expect(profile).toMatch(/NOVEL/);
    expect(profile).toMatch(/attachment point/i);
  });

  it('still covers the defect case — this is additive, not a replacement', () => {
    expect(profile).toMatch(/SYMPTOM vs CAUSE|symptom.*cause/i);
  });

  it('preserves the machine-checked output contract (file/function/reason JSON shape)', () => {
    expect(profile).toMatch(/"file":/);
    expect(profile).toMatch(/"function":/);
    expect(profile).toMatch(/Never invent a module or symbol name/);
  });
});

describe('the two restore sources stay identical (memory: profiles.json.original is what tier3 restores from)', () => {
  it('profiles.json and profiles.json.original carry the same detective text', () => {
    const a = JSON.parse(readFileSync(join(__dirname, '../../../orchestrations/agents/profiles.json'), 'utf8'))['code-graph-detective'];
    const b = JSON.parse(readFileSync(join(__dirname, '../../../orchestrations/agents/profiles.json.original'), 'utf8'))['code-graph-detective'];
    expect(a).toBe(b);
  });
});
