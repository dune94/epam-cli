/**
 * THE HARNESS OBEYS WHAT THE SEAM DECLARES.
 *
 * The per-agent harness exists so an agent can be proven to work without spending a run. On
 * 2026-08-23 it reported two working agents as broken, both times because it substituted its own
 * contract for the one the registry states:
 *
 *   prompt-builder   FAIL "produces 'project-prompts' but the reply carries no JSON"
 *                    The seam declares `_outputIsArtefact` — its output IS the prompt text on
 *                    disk. Demanding JSON of it was the harness inventing a shape.
 *
 *   roster-review    FAIL "spawnSync bash ETIMEDOUT"
 *                    The seam declares timeoutSecs: 900. The harness used a flat 300 for every
 *                    seam, cutting it off at a third of its budget and calling that an agent
 *                    failure.
 *
 * A harness that fails working agents is worse than no harness: it sends you hunting a defect in
 * the pipeline that lives in the tool. Both decisions are now pure functions, asserted here against
 * the REAL registry entries, so neither can drift back to a guess.
 *
 * ZERO TOKENS. Nothing here calls a model.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const harness = require(join(ROOT, 'orchestrations/scripts/agent-check.js'));
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

/** A seam's real declaration, read from the registry — never restated here. */
const seam = (name: string): Record<string, unknown> => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  let found: Record<string, unknown> | null = null;
  (function walk(o: Record<string, unknown>) {
    for (const k of Object.keys(o)) {
      const v = o[k] as Record<string, unknown>;
      if (v && typeof v === 'object') {
        if (k === name && typeof v.template === 'string') found = v;
        walk(v);
      }
    }
  }(JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles || reg));
  if (!found) throw new Error(`no seam '${name}' in the registry — this test would prove nothing`);
  return found;
};

describe('the timeout comes from the seam, not from the harness', () => {
  it('gives roster-review the 900s IT DECLARES, not a flat default', () => {
    const p = seam('roster-review');
    expect(p.timeoutSecs, 'roster-review no longer declares a timeout').toBe(900);
    const ms = harness.budgetFor(p, { timeoutMs: '300000', timeoutMsExplicit: false });
    expect(ms, 'the harness cut a 900s seam off at its own default and blamed the agent')
      .toBe(900000);
  });

  it('falls back only when a seam declares nothing', () => {
    expect(harness.budgetFor({}, { timeoutMs: '300000', timeoutMsExplicit: false })).toBe(300000);
  });

  it('an operator passing --timeout-ms still wins', () => {
    // Narrowing the budget deliberately is a different act from defaulting into one.
    const p = seam('roster-review');
    expect(harness.budgetFor(p, { timeoutMs: '5000', timeoutMsExplicit: true })).toBe(5000);
  });

  it('every seam that declares a timeout is given it', () => {
    // The class, not the one site. Any seam whose declared budget the harness would shorten.
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const shortened: string[] = [];
    (function walk(o: Record<string, unknown>) {
      for (const k of Object.keys(o)) {
        const v = o[k] as Record<string, unknown>;
        if (v && typeof v === 'object') {
          if (typeof v.template === 'string' && Number(v.timeoutSecs) > 0) {
            const got = harness.budgetFor(v, { timeoutMs: '300000', timeoutMsExplicit: false });
            if (got !== Number(v.timeoutSecs) * 1000) shortened.push(`${k}:${v.timeoutSecs}s->${got}ms`);
          }
          walk(v);
        }
      }
    }((reg.profiles || reg) as Record<string, unknown>));
    expect(shortened, `seams the harness would cut short: ${shortened.join(', ')}`).toEqual([]);
  });
});

describe('the reply shape comes from the seam, not from the harness', () => {
  it('accepts prose from a seam that declares its output IS the artefact', () => {
    const p = seam('prompt-builder');
    expect(p._outputIsArtefact, 'prompt-builder no longer declares its output is the artefact')
      .toBeTruthy();
    const v = harness.checkReply('You are the X engineer. Your scope is...', String(p.produces), p);
    expect(v.ok, 'a prompt-writing agent was failed for not answering in JSON').toBe(true);
  });

  it('still demands JSON from a seam that declares a verdict', () => {
    // The exemption must not become a blanket pass — roster-review really does owe a verdict.
    const p = seam('roster-review');
    expect(p._outputIsArtefact).toBeFalsy();
    const v = harness.checkReply('Looks fine to me.', String(p.produces), p);
    expect(v.ok, 'a verdict seam was allowed to answer in prose').toBe(false);
  });

  it('an empty reply always fails, whatever the seam declares', () => {
    const p = seam('prompt-builder');
    expect(harness.checkReply('', String(p.produces), p).ok).toBe(false);
    expect(harness.checkReply('   ', String(p.produces), p).ok).toBe(false);
  });
});
