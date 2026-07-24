/**
 * B6 — cost must be attributed to the agent that spent it.
 *
 * The 9cbcec0 fix made spec-mode emit cost at all (totals went from 32% of real
 * spend to ~105%). But `runClaude` defaults the label to 'spec-mode-agent' and no
 * call site overrode it, so every agent it drives landed in one opaque bucket.
 * Live proof, minutes after that fix shipped:
 *
 *     spec-mode-agent       $0.3688    <- detective + openspec + speckit + VC
 *     team-lead-agent       $0.0741       reviewer + PRD change reviewer, merged
 *     typescript-engineer   $0.1428
 *     code-graph-detective  5 events, 0 cost_snapshots
 *
 * So "what did this run cost" became answerable while "which agent costs most"
 * did not — and that is the question that drives model/ladder tuning.
 *
 * This is the SAME omission shape twice in one day: emits got presence but not
 * cost, then cost but not attribution. See [[feedback_test_the_malformed_artifact]]
 * rule 4 — when adding a capability across N call sites, check every attribute
 * that matters, not just presence.
 *
 * Note these assert on the CALL SITES rather than on emitted output: attribution is
 * a property of who calls runClaude, and a runtime test would need a live LLM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

/** Body of the named function, up to the next top-level `async function`. */
function fnBody(name: string): string {
  const i = SPEC.indexOf(`async function ${name}(`);
  if (i === -1) throw new Error(`function not found: ${name}`);
  const next = SPEC.indexOf('\nasync function ', i + 10);
  return SPEC.slice(i, next === -1 ? SPEC.length : next);
}

describe('B6 — every spec-mode agent names itself when emitting cost', () => {
  it('the code-graph-detective attributes its own spend', () => {
    const body = fnBody('runCodeGraphDetective');
    expect(body).toMatch(/costAgent:\s*['"]code-graph-detective['"]/);
  });

  it('the detective attributes BOTH its explore and its extract phase', () => {
    // Two runClaude calls; the extract phase is a real second LLM call and its
    // tokens are not free.
    const body = fnBody('runCodeGraphDetective');
    const hits = [...body.matchAll(/costAgent:/g)].length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('the VC agent attributes its spend', () => {
    expect(fnBody('_vcLlmCall')).toMatch(/costAgent:/);
  });

  it('the PRD change reviewer attributes its spend', () => {
    expect(fnBody('reviewPrdChange')).toMatch(/costAgent:/);
  });

  it('runAgentForJson attributes by its `tag` (openspec / speckit / coordinator)', () => {
    // This helper already receives the agent identity as `tag` — use it rather
    // than inventing a second naming scheme.
    const body = fnBody('runAgentForJson');
    expect(body).toMatch(/costAgent:\s*tag/);
  });

  it('the generic fallback label remains, so an unlabelled call still records cost', () => {
    // Attribution must never come at the price of DROPPING cost — an unnamed
    // caller should still land somewhere rather than vanish.
    expect(SPEC).toMatch(/costAgent\s*\|\|.*['"]spec-mode-agent['"]/);
  });
});
