// SECTION 6 OF change-log/SEAM-CONSISTENCY-ANALYSIS.md — two declared inconsistencies:
//
// 1. openrouter had no finalFallback while the other 3 sets did (undocumented gap). Fixed to
//    declare one ROUTED WITHIN the set (not an escape to paid claude), since this is the live
//    production stack.
// 2. mockserver's finalFallback used provider:"claude" with its own $why calling that a "paid
//    escape" risk — WRONG: mockserver is a no-pay mock endpoint by construction (its own
//    runners.claude declares an ANTHROPIC_BASE_URL redirect + a credential scrub that apply to
//    EVERY call routed under this set, finalFallback included). Fixed the documentation, not the
//    value — and this test guards the claim by asserting the redirect is still there, not just
//    reading the comment that says so.
//
// finalFallback itself is currently DEAD CONFIG — nothing in the live ladder-exhaustion path
// reads it (confirmed by reading llm-handler.sh:772, claude.sh:7913,
// brownfield-repro-test-writer.sh:682, all of which just retry the same rung on exhaustion).
// agent-check.js's dry-run estimator is the only reader, and even it never reaches finalFallback
// while any ladder tier has a startModel — true for all 4 sets. These tests therefore assert the
// DECLARATION is correct and internally consistent, not that a run can currently reach it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const openrouter = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.openrouter.json'), 'utf8'));
const mockserver = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.mockserver.json'), 'utf8'));
const claudeSet = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.claude.json'), 'utf8'));
const codemieSet = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.codemie.json'), 'utf8'));

/** Every model that is the TOP of some ladder chain in this set (never escalated past). */
function topRungModels(set: any): Set<string> {
  const tops = new Set<string>();
  for (const tier of Object.values<any>(set.ladders || {})) {
    const froms = new Set((tier.modelLadder || []).map((l: any) => l.from));
    for (const l of tier.modelLadder || []) {
      if (!froms.has(l.to)) tops.add(l.to); // nothing escalates FROM this model -> it's terminal
    }
  }
  return tops;
}

describe('finalFallback is declared for all 4 provider sets', () => {
  it('openrouter now declares one — the previously undocumented gap', () => {
    expect(openrouter.finalFallback, 'openrouter still has no finalFallback').toBeTruthy();
    expect(openrouter.finalFallback.model).toBeTruthy();
    expect(openrouter.finalFallback.provider).toBeTruthy();
  });

  it('claude, codemie and mockserver still declare theirs — no regression', () => {
    for (const [name, set] of [['claude', claudeSet], ['codemie', codemieSet], ['mockserver', mockserver]] as const) {
      expect(set.finalFallback, `${name} lost its finalFallback`).toBeTruthy();
    }
  });
});

describe("openrouter's finalFallback is routed WITHIN the set, not an escape to paid claude", () => {
  it('provider is "openrouter" — not "claude"', () => {
    expect(openrouter.finalFallback.provider).toBe('openrouter');
  });

  it('"openrouter" is genuinely ROUTABLE under EPAM_PROVIDER_SET=openrouter — executed, not assumed', () => {
    const out = execFileSync('node', [join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-providers.js')], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_PROVIDER_SET: 'openrouter' },
    });
    const routable = JSON.parse(out);
    expect(routable, `not routable: ${out}`).toContain('openrouter');
  });

  it('the fallback model is NOT the top rung of any of this set\'s own ladders — a real second answer', () => {
    const tops = topRungModels(openrouter);
    expect([...tops].length, 'no top-rung models computed — the test would pass vacuously').toBeGreaterThan(0);
    expect(tops.has(openrouter.finalFallback.model),
      `${openrouter.finalFallback.model} is a top rung: {${[...tops].join(', ')}} — it would just retry the model that already failed`)
      .toBe(false);
  });
});

describe("mockserver's finalFallback provider:\"claude\" is safe BECAUSE this set redirects it — not because the name looks harmless", () => {
  it('this set\'s own "claude" runner still declares the MockServer redirect', () => {
    const env = mockserver.runners?.claude?.env || {};
    expect(env.ANTHROPIC_BASE_URL, 'the redirect that makes provider:"claude" safe in this set is gone').toBe('mockBaseUrl');
  });

  it('this set\'s own "claude" runner still scrubs every OTHER vendor\'s credentials', () => {
    const scrubbed: string[] = mockserver.runners?.claude?.unsetEnv || [];
    for (const v of ['OPENROUTER_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY']) {
      expect(scrubbed, `${v} is no longer scrubbed — a live route out of the mock`).toContain(v);
    }
  });

  it('ANTHROPIC_API_KEY / CLAUDE_* are deliberately NOT scrubbed — OAuth fallback would bill for real', () => {
    // The inverse guard: scrubbing these would send Claude Code to the OAuth credentials on disk,
    // which DOES bill (seam-the-subscription-pays-not-the-api-key). Mockserver's redirect only
    // works because ANTHROPIC_API_KEY stays present and pointed at the mock.
    const scrubbed: string[] = mockserver.runners?.claude?.unsetEnv || [];
    expect(scrubbed).not.toContain('ANTHROPIC_API_KEY');
  });
});
