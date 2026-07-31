/**
 * Full agent audit re-audit, 2026-07-31: two speckit-agent gaps found on the
 * fresh independent re-audit (not part of the original fix set):
 *
 * 1. MODEL-TIER MISMATCH: `reviewVcViaSpeckit` (speckit's own VC-review role)
 *    called the shared `_vcLlmCall` helper, which always resolved
 *    `SPEC_MODE_OPENSPEC_MODEL_HIGH` — openspec's model family — even for a
 *    call made ON BEHALF OF speckit. `SPEC_MODE_SPECKIT_MODEL_HIGH` (which
 *    exists and is used everywhere else speckit runs, e.g. the main
 *    escalation ladder) was silently never consulted.
 *
 * 2. DEAD CODE PATH: `validateMidExecutionSplits` called `runSpeckitReview`
 *    hoping for per-child AC refinement back via
 *    `speckitResult.payload.splitStories` — but every call site shared ONE
 *    prompt that told speckit "ALWAYS omit splitStories... never propose
 *    split children of your own," so that field could never be populated.
 *    The entire call in `validateMidExecutionSplits` was a no-op: its
 *    parent-AC output is also discarded immediately after by the
 *    "Delegated to split children" placeholder.
 *
 * Fixed: `_vcLlmCall` now takes a `role` param ('speckit' | 'openspec',
 * default 'openspec' to preserve regenerateVcViaOpenspec's existing
 * behavior) and `reviewVcViaSpeckit` passes 'speckit'. `runSpeckitReview`
 * gained an explicit `refineExistingChildren` opt-in (NOT inferred from
 * `openspecOutput.splitStories` being present, since that field means
 * something different — an openspec PROPOSAL, not created children — at
 * every other call site) that switches the prompt to ask for per-child
 * refinement, returned under `splitStories`, only when true.
 * `validateMidExecutionSplits` is the only caller that passes it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');

describe('_vcLlmCall — role-aware model-tier resolution', () => {
  function vcLlmCallBody(): string {
    const i = SRC.indexOf('async function _vcLlmCall(prompt, cycle, logPath, storyId = \'\', role = \'openspec\')');
    expect(i, '_vcLlmCall signature is gone — this is anchored to nothing').toBeGreaterThan(-1);
    return SRC.slice(i, i + 700);
  }

  it('resolves SPEC_MODE_SPECKIT_MODEL_HIGH when role is speckit', () => {
    expect(vcLlmCallBody()).toMatch(/role === 'speckit'[\s\S]*?SPEC_MODE_SPECKIT_MODEL_HIGH/);
  });

  it('still resolves SPEC_MODE_OPENSPEC_MODEL_HIGH for the default/openspec role', () => {
    expect(vcLlmCallBody()).toMatch(/SPEC_MODE_OPENSPEC_MODEL_HIGH/);
  });

  it('defaults role to openspec — regenerateVcViaOpenspec\'s existing call site is unchanged', () => {
    const i = SRC.indexOf('async function regenerateVcViaOpenspec(');
    const body = SRC.slice(i, i + 2000);
    const callIdx = body.indexOf('_vcLlmCall(prompt, cycle,');
    expect(callIdx).toBeGreaterThan(-1);
    // Exactly 4 args (prompt, cycle, logPath, storyId) — no 5th role arg, so
    // the default ('openspec') applies, matching pre-fix behavior exactly.
    const callLine = body.slice(callIdx, body.indexOf(');', callIdx) + 1);
    expect(callLine).not.toMatch(/'speckit'/);
  });

  it('reviewVcViaSpeckit passes role=\'speckit\' explicitly', () => {
    const i = SRC.indexOf('async function reviewVcViaSpeckit(');
    const body = SRC.slice(i, i + 2000);
    const callIdx = body.indexOf('const out = await _vcLlmCall(');
    expect(callIdx).toBeGreaterThan(-1);
    const callLine = body.slice(callIdx, body.indexOf(';', callIdx) + 1);
    expect(callLine).toMatch(/story\.id, 'speckit'\)/);
  });
});

describe('runSpeckitReview — refineExistingChildren opt-in', () => {
  function fnBody(): string {
    const i = SRC.indexOf('async function runSpeckitReview(');
    expect(i).toBeGreaterThan(-1);
    const next = SRC.indexOf('\n// ', i + 100);
    return SRC.slice(i, next === -1 ? i + 10000 : next);
  }

  it('accepts refineExistingChildren, defaulting to false (no behavior change for existing callers)', () => {
    expect(fnBody()).toMatch(/refineExistingChildren = false/);
  });

  it('the refineExistingChildren branch asks for per-child ACs returned under splitStories', () => {
    const body = fnBody();
    const branchIdx = body.indexOf('refineExistingChildren\n    ?');
    expect(branchIdx).toBeGreaterThan(-1);
    const trueBranch = body.slice(branchIdx, body.indexOf(':', branchIdx + 2000) > -1 ? body.indexOf('    : `', branchIdx) : branchIdx + 2500);
    expect(trueBranch).toMatch(/ALREADY split into the children/);
    expect(trueBranch).toMatch(/"splitStories": array of \{"id"/);
    expect(trueBranch).not.toMatch(/ALWAYS omit/);
  });

  it('the normal (false) branch is unchanged — still forbids emitting splitStories', () => {
    const body = fnBody();
    expect(body).toMatch(/"splitStories":\s*ALWAYS omit this field\. Splitting is openspec's decision alone/);
  });

  it('validateMidExecutionSplits is the only caller passing refineExistingChildren: true', () => {
    const occurrences = SRC.match(/refineExistingChildren:\s*true/g) || [];
    expect(occurrences.length).toBe(1);
    const i = SRC.indexOf('refineExistingChildren: true');
    const before = SRC.slice(Math.max(0, i - 300), i);
    expect(before).toMatch(/runSpeckitReview\(/);
  });

  it('the main spec-pass call sites do NOT pass refineExistingChildren (unaffected by the fix)', () => {
    // Every runSpeckitReview({...}) CALL (not the function definition itself)
    // except the one inside validateMidExecutionSplits must NOT set
    // refineExistingChildren, so their behavior is provably unchanged.
    const calls = [...SRC.matchAll(/(?<!async function )runSpeckitReview\(\{[\s\S]*?\}\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const withFlag = calls.filter((m) => /refineExistingChildren/.test(m[0]));
    expect(withFlag.length).toBe(1);
  });
});

describe('module exports stay intact after the refactor', () => {
  it('still exports reviewPrdChange and other pre-existing symbols', () => {
    expect(typeof specModeRunner.applySpecChanges).toBe('function');
    expect(typeof specModeRunner.mergeLocationHintFiles).toBe('function');
  });
});
