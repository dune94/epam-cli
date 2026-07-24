/**
 * VC prompt hardening — prevent prescriptive drift (AC/VC/TC design, 2026-07-24).
 *
 * Found live (AMSD-1820 confirmation run): the VC layer NEVER converged and fell
 * back for a reason the mechanism-guard couldn't catch — the producer and reviewer
 * prompts DISAGREED. The producer prompt listed "an API response field" as a valid
 * observable VC target; speckit flagged that same "booking confirmation data (a
 * response field)" as an implementation mechanism. So the producer kept re-emitting
 * it and the reviewer kept flagging it → forced fallback every cycle. A second
 * class also slipped through: cross-comparison VCs ("the return amount must equal
 * the outbound amount") that silently presume a copy/split mechanism.
 *
 * Fixes locked in here:
 *  1. ONE shared rules constant (VC_OBSERVABILITY_RULES) is the single source of
 *     truth used verbatim by the producer (archaeology STEP 3 + regenerate) AND the
 *     reviewer (speckit) — so they can never disagree again.
 *  2. The rules explicitly forbid (a) internal structures/response fields that merely
 *     FEED the ticket's surface and (b) cross-comparison assertions.
 *  3. VC calls run at temperature 0 + LOW reasoning effort: VC production is a
 *     RESTATE task, and high effort is exactly what reasons its way into a mechanism.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC_PATH = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildBrownfieldArchaeologyBlock, VC_OBSERVABILITY_RULES } = spec;
const src = readFileSync(SPEC_PATH, 'utf8');

describe('VC_OBSERVABILITY_RULES — the shared source of truth', () => {
  it('is exported and forbids the two failure classes that forced AMSD-1820 to fall back', () => {
    expect(typeof VC_OBSERVABILITY_RULES).toBe('string');
    // internal-structure / response-field ban (the producer↔reviewer disagreement)
    expect(VC_OBSERVABILITY_RULES).toMatch(/INTERNAL structure/);
    expect(VC_OBSERVABILITY_RULES).toMatch(/response field/i);
    // cross-comparison ban (the "return equals outbound" mechanism-in-disguise)
    expect(VC_OBSERVABILITY_RULES).toMatch(/CROSS-COMPARISON/);
    expect(VC_OBSERVABILITY_RULES).toMatch(/must equal/i);
    // still a black-box, observable-only rule
    expect(VC_OBSERVABILITY_RULES).toMatch(/BLACK-BOX/);
  });
});

describe('single source of truth — producer and reviewer share the exact same text', () => {
  it('the shared constant is interpolated in ALL THREE prompt sites (not re-worded per site)', () => {
    // archaeology STEP 3 (primary producer), regenerate (openspec), review (speckit)
    const uses = src.match(/\$\{VC_OBSERVABILITY_RULES\}/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('the producer prompt no longer lists a bare "API response field" as an observable target', () => {
    // that exact phrasing is what the reviewer flagged; it must be gone from the producer side
    expect(src).not.toMatch(/a rendered\/returned value, an API response field, a log line/);
  });
});

describe('archaeology STEP 3 (producer) actually carries the hardened rules', () => {
  it('brownfield archaeology block embeds the cross-comparison + internal-structure bans', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/CROSS-COMPARISON/);
    expect(archaeologyBlock).toMatch(/INTERNAL structure/);
    // and it warns the producer that a strict reviewer enforces the SAME text
    expect(archaeologyBlock).toMatch(/strict reviewer holds you to this SAME text/);
  });

  it('greenfield emits no VC block at all (unchanged behavior)', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({});
    expect(archaeologyBlock).toBe('');
  });
});

describe('VC calls run deterministic + low-effort (restate, do not reason toward a mechanism)', () => {
  it('_vcLlmCall pins temperature 0 and LOW reasoning effort (env-overridable)', () => {
    expect(src).toMatch(/EPAM_TEMPERATURE: process\.env\.VC_LLM_TEMPERATURE \|\| '0'/);
    expect(src).toMatch(/EPAM_REASONING_EFFORT: process\.env\.VC_LLM_REASONING_EFFORT \|\| 'low'/);
  });
});
