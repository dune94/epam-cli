/**
 * Tests for brownfield surgeon mode — four changes that enforce find-first/fix-minimal
 * orientation when EPAM_BROWNFIELD=1, without affecting greenfield flow.
 *
 * Changes tested (source-text assertions, since the functions are internal):
 *   1. claude.sh: brownfield surgeon preamble injected into DYNAMIC_CONSTITUTION
 *   2. spec-mode-runner.js: openspec gets brownfield archaeology block + locationHint schema
 *   3. spec-mode-runner.js: Semble runs a service-boundary query in addition to symptom query
 *   4. spec-mode-runner.js: openspec model selection uses HIGH model when brownfield
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT   = join(__dirname, '../../../');
const CLAUDE_SH   = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');

const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const specSrc   = readFileSync(SPEC_RUNNER, 'utf8');
const { buildBrownfieldArchaeologyBlock } = require(SPEC_RUNNER);

// ─── Change 1: claude.sh brownfield surgeon preamble ────────────────────────

describe('claude.sh — brownfield surgeon preamble (Change 1)', () => {
  it('preamble is injected only inside an EPAM_BROWNFIELD=1 guard', () => {
    // Locate the guard block
    const guardIdx = claudeSrc.indexOf('EPAM_BROWNFIELD:-0}" = "1"');
    expect(guardIdx).toBeGreaterThan(-1);
    // The surgeon rules must appear after the guard
    const afterGuard = claudeSrc.slice(guardIdx);
    expect(afterGuard).toMatch(/BROWNFIELD SURGEON MODE/);
  });

  it('preamble includes FIND FIRST rule', () => {
    expect(claudeSrc).toMatch(/FIND FIRST/);
  });

  it('preamble includes FIX MINIMALLY rule', () => {
    expect(claudeSrc).toMatch(/FIX MINIMALLY/);
  });

  it('preamble includes NO NEW FILES rule', () => {
    expect(claudeSrc).toMatch(/NO NEW FILES/);
  });

  it('preamble includes USE EXISTING HELPERS rule', () => {
    expect(claudeSrc).toMatch(/USE EXISTING HELPERS/);
  });

  it('preamble appends to DYNAMIC_CONSTITUTION so it composes with project constitution-rules.json', () => {
    // Must use DYNAMIC_CONSTITUTION="${DYNAMIC_CONSTITUTION}..." pattern so it stacks
    const brownfieldBlock = (() => {
      const startIdx = claudeSrc.indexOf('BROWNFIELD SURGEON MODE');
      const guardIdx = claudeSrc.lastIndexOf('EPAM_BROWNFIELD:-0}" = "1"', startIdx);
      return claudeSrc.slice(guardIdx, startIdx + 200);
    })();
    expect(brownfieldBlock).toMatch(/DYNAMIC_CONSTITUTION="\$\{DYNAMIC_CONSTITUTION\}/);
  });

  it('preamble is not injected in the greenfield path (no unconditional write to DYNAMIC_CONSTITUTION with surgeon text)', () => {
    // The surgeon text must only appear INSIDE a brownfield guard — never outside one
    const surgeonIdx = claudeSrc.indexOf('BROWNFIELD SURGEON MODE');
    expect(surgeonIdx).toBeGreaterThan(-1);
    // The nearest preceding if-guard must be the brownfield one
    const beforeSurgeon = claudeSrc.slice(0, surgeonIdx);
    const lastIfIdx = beforeSurgeon.lastIndexOf('if [');
    const lastIf = claudeSrc.slice(lastIfIdx, surgeonIdx);
    expect(lastIf).toMatch(/EPAM_BROWNFIELD/);
  });
});

// ─── Change 2: openspec brownfield archaeology block ────────────────────────

describe('spec-mode-runner.js — brownfield archaeology block, REAL behavior via buildBrownfieldArchaeologyBlock (Change 2)', () => {
  // Real bug (2026-07-23, live AMSD-1820 failure): the ORIGINAL version of
  // this describe block asserted the archaeology block was gated on
  // `agent === 'openspec'` — i.e. it tested that the bug's condition existed,
  // via static regex over the source text, and passed happily while the real
  // pipeline shipped a story with zero file guidance because the coordinator
  // assigned only speckit (openspec ran "0 stories" that phase). A source-text
  // "does X exist" assertion cannot catch "X only fires for one of two valid
  // callers" — these tests now call the real, exported, pure function with
  // both agent shapes and assert on its actual return value instead.

  it('fires for EPAM_BROWNFIELD=1 regardless of which agent is running — the exact gap that broke AMSD-1820', () => {
    const openspecResult = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    const speckitResult = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    // buildBrownfieldArchaeologyBlock takes no agent parameter at all — its
    // whole point is that the block no longer depends on which agent calls it.
    expect(openspecResult.archaeologyBlock).not.toBe('');
    expect(speckitResult.archaeologyBlock).not.toBe('');
    expect(openspecResult.archaeologyBlock).toBe(speckitResult.archaeologyBlock);
  });

  it('archaeology block instructs the agent to identify the existing fix site', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/BROWNFIELD MODE/);
    expect(archaeologyBlock).toMatch(/locationHint/);
  });

  it('archaeology block explicitly forbids tool use and requires JSON-only output', () => {
    // GLM-5.1 emitted <search_fi...> XML on the first live run when given
    // "you MUST identify the existing code path" without a no-tools constraint.
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/no tools|no tool/i);
    expect(archaeologyBlock).toMatch(/JSON only|output JSON/i);
  });

  it('archaeology block constrains locationHint derivation to the Semble context already in the prompt', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/ONLY.*EXISTING CODE|already present in this prompt|Semble/i);
  });

  it('archaeology block instructs model to set locationHint to [] when no Semble context is available', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/locationHint.*\[\]|\[\].*locationHint/s);
  });

  it('locationHint schema line is added for brownfield regardless of agent', () => {
    const { schemaLine } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(schemaLine).toMatch(/locationHint/);
    expect(schemaLine).not.toBe('');
  });

  it('locationHint includes file, function, and reason fields', () => {
    const { schemaLine } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(schemaLine).toMatch(/"file".*"function".*"reason"|locationHint.*file.*function.*reason/s);
  });

  it('archaeology block and schema line are both empty when EPAM_BROWNFIELD is not "1" — greenfield unaffected', () => {
    expect(buildBrownfieldArchaeologyBlock({}).archaeologyBlock).toBe('');
    expect(buildBrownfieldArchaeologyBlock({}).schemaLine).toBe('');
    expect(buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '0' }).archaeologyBlock).toBe('');
    expect(buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: 'true' }).archaeologyBlock).toBe('');
  });

  it('the real prompt-building call site actually uses buildBrownfieldArchaeologyBlock, not a private inline ternary re-implementing the same logic', () => {
    // Guards against a future edit silently reverting to an inline, per-agent
    // condition without touching (or breaking) this test file.
    expect(specSrc).toMatch(/buildBrownfieldArchaeologyBlock\(process\.env\)/);
  });
});

// ─── Change 3: Semble service-boundary query for brownfield ─────────────────

describe('spec-mode-runner.js — Semble service-boundary query (Change 3)', () => {
  it('fetchSembleContext has an isBrownfield branch', () => {
    expect(specSrc).toMatch(/isBrownfield\s*=\s*process\.env\.EPAM_BROWNFIELD\s*===\s*['"]1['"]/);
  });

  it('brownfield path runs a second pathQuery using action verbs targeting the code handler', () => {
    expect(specSrc).toMatch(/handles.*applies.*processes|applies.*handles.*processes/);
  });

  it('brownfield path deduplicates results by file+line before injecting', () => {
    const sembleIdx = specSrc.indexOf('function fetchSembleContext');
    const sembleFn = specSrc.slice(sembleIdx, sembleIdx + 2000);
    expect(sembleFn).toMatch(/seen\s*=\s*new Set/);
    expect(sembleFn).toMatch(/seen\.has|seen\.add/);
  });

  it('brownfield result block label says "identify the code path" not "write precise ACs"', () => {
    expect(specSrc).toMatch(/identify the code path that handles/);
  });

  it('greenfield path label is unchanged', () => {
    expect(specSrc).toMatch(/use this to write precise, grounded ACs/);
  });

  it('symptomQuery is computed the same way in both greenfield and brownfield paths', () => {
    // Both must use story.title + acceptanceCriteria slice
    const sembleIdx = specSrc.indexOf('function fetchSembleContext');
    const sembleFn = specSrc.slice(sembleIdx, sembleIdx + 2500);
    expect(sembleFn).toMatch(/symptomQuery\s*=\s*\[story\.title/);
  });
});

// ─── Change 4: Stronger model for brownfield openspec ───────────────────────

describe('spec-mode-runner.js — stronger model for brownfield openspec (Change 4)', () => {
  it('openspec model selection checks EPAM_BROWNFIELD before choosing base model', () => {
    const openspecModelIdx = specSrc.indexOf('SPEC_MODE_OPENSPEC_MODEL_HIGH');
    expect(openspecModelIdx).toBeGreaterThan(-1);
    // The HIGH model reference must be near a brownfield check
    const region = specSrc.slice(openspecModelIdx - 200, openspecModelIdx + 200);
    expect(region).toMatch(/EPAM_BROWNFIELD/);
  });

  it('when EPAM_BROWNFIELD=1, openspec uses SPEC_MODE_OPENSPEC_MODEL_HIGH as base model', () => {
    // The conditional must prefer _HIGH when brownfield
    const openspecBlock = (() => {
      const idx = specSrc.indexOf("logName.includes('openspec')");
      return specSrc.slice(idx, idx + 400);
    })();
    expect(openspecBlock).toMatch(/EPAM_BROWNFIELD.*SPEC_MODE_OPENSPEC_MODEL_HIGH/s);
  });

  it('when EPAM_BROWNFIELD is not set, openspec falls back to base SPEC_MODE_OPENSPEC_MODEL', () => {
    // The else-branch of the ternary must reference the base model (without _HIGH suffix).
    // Extend the window to 700 chars to cover the full multi-line ternary.
    const openspecBlock = (() => {
      const idx = specSrc.indexOf("logName.includes('openspec')");
      return specSrc.slice(idx, idx + 700);
    })();
    // The ternary's else branch uses SPEC_MODE_OPENSPEC_MODEL (base) as fallback
    expect(openspecBlock).toMatch(/:\s*process\.env\.SPEC_MODE_OPENSPEC_MODEL\s*\|\|/);
  });

  it('speckit model selection is unaffected by EPAM_BROWNFIELD', () => {
    const speckitBlock = (() => {
      const idx = specSrc.indexOf("logName.includes('speckit')");
      return specSrc.slice(idx, idx + 200);
    })();
    expect(speckitBlock).not.toMatch(/EPAM_BROWNFIELD/);
  });
});
