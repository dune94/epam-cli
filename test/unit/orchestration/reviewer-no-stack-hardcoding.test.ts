/**
 * The reviewer must not carry another project's stack or model list.
 *
 * Live metrolinx 2026-07-29. `prd-change-reviewer` rejected correct guidance for
 * the project actually being worked on:
 *
 *   "the added text references Contentstack ... and the allowed stack is
 *    TypeScript/Node.js/Express/Vitest only"
 *
 * That list is the travel-app's stack. Metrolinx is Next.js + Contentstack, so
 * the reviewer was rejecting accurate advice about the real codebase because a
 * constant in a profile disagreed with reality.
 *
 * The same profile also pins the models:
 *
 *   "The assigned model is not one of: MiniMax-M3, MiniMax-M2.5, z-ai/glm-5.1,
 *    z-ai/glm-5.2"
 *
 * `moonshotai/kimi-k3` is configured as EPAM_FINAL_FALLBACK_MODEL and sits at the
 * top of EPAM_MODEL_LADDER_HIGH — and would be REJECTED by this reviewer if the
 * ladder ever reached it. So kimi was unreachable twice over: the retry budget
 * could not climb that far (LAD-1), and the reviewer would have refused it on
 * arrival.
 *
 * Both are the same error: a fact that varies per project, frozen into an agent
 * profile. Enum-style rules that are genuinely universal — effort must be
 * low/medium/high, cpaGate must be pass/review/block — are fine, because those
 * enums are the pipeline's own vocabulary, not a client's.
 *
 * profiles.canonical.json is the tracked source; profiles.json is restored from
 * it every run. Both must be clean or the next restore reintroduces the rule.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');

function reviewer(file: string): string {
  const p = JSON.parse(readFileSync(join(AGENTS, file), 'utf8'));
  const t = p['prd-change-reviewer'];
  expect(t, `prd-change-reviewer missing from ${file}`).toBeTruthy();
  return t as string;
}

/**
 * Every profile in a file, concatenated. Asserting on ALL of them rather than on
 * one key: prd-change-reviewer happens to be where this was found, but the same
 * frozen list could be pasted into any profile, and profiles.canonical.json does
 * not even contain that key (46 profiles, none of them the reviewer).
 */
function allProfiles(file: string): string {
  const p = JSON.parse(readFileSync(join(AGENTS, file), 'utf8'));
  return Object.values(p).map((v) => String(v)).join('\n');
}

const FILES = ['profiles.json', 'profiles.canonical.json'];

describe('no client stack is frozen into the reviewer', () => {
  for (const f of FILES) {
    it(`${f} names no specific technology stack`, () => {
      const t = allProfiles(f);
      // The travel-app list, and any successor written the same way.
      expect(t, 'a fixed stack list rejects correct guidance on every other project')
        .not.toMatch(/TypeScript\/Node\.js\/Express\/Vitest/);
      expect(t, 'a fixed stack list rejects correct guidance on every other project')
        .not.toMatch(/stack \([A-Za-z.\/]+ only\)/);
    });
  }
});

describe('no model allowlist is frozen into the reviewer', () => {
  // Scoped to the reviewer, and to a REJECTION RULE that enumerates models —
  // not to any mention of a model name. Other profiles legitimately discuss
  // models (the spec coordinator assigns them); the defect is a gate that
  // vetoes what the project configured.
  {
    const f = 'profiles.json';
    it(`${f} does not enumerate permitted models as a rejection rule`, () => {
      const t = reviewer(f);
      // Models come from EPAM_MODEL_LADDER_* / EPAM_FINAL_FALLBACK_MODEL, which
      // are per-project config. A list here silently vetoes the configured
      // ladder — kimi-k3 is configured and would be rejected.
      expect(t, 'the reviewer vetoes models the project has configured')
        .not.toMatch(/assigned model is not one of/i);
    });

    it(`${f} does not enumerate permitted providers`, () => {
      expect(reviewer(f), 'a provider allowlist blocks any newly configured provider')
        .not.toMatch(/aiProvider is not one of/i);
    });
  }
});

describe('genuinely universal rules are kept', () => {
  it('still constrains the pipeline\'s own enums', () => {
    // These are the pipeline's vocabulary, not a client's technology choice —
    // removing them would be over-correction.
    const t = reviewer('profiles.json');
    expect(t).toMatch(/effort is not one of: low, medium, high/);
    expect(t).toMatch(/cpaGate is not one of: pass, review, block/);
  });

  it('still forbids overwriting a pre-existing model assignment', () => {
    // The real invariant the model rule was protecting: the coordinator fills
    // gaps, it does not overwrite. That survives without naming any model.
    expect(reviewer('profiles.json')).toMatch(/coordinator must only fill gaps, never overwrite/i);
  });
});
