/**
 * THE VALIDATOR KNOWS EVERY TAG THE PIPELINE BINDS, AND ENFORCES DECLARED ENUMS.
 *
 * agent-output-schema.js mapped six tags. The runner binds nine. So ESTATE_SURVEY,
 * PROJECT_AGENTS, ROSTER_REVIEW and ROLE_ASSIGNMENTS returned `ok: true` for ANY payload —
 * validation was a no-op for four seams, all of which run before pause 1.
 *
 * It also checked types only — string/number/boolean/array — and never an `enum`. So a tool that
 * declares `verdict: {enum: [sound, defects_found, nothing_to_review]}` would accept `warn`
 * regardless. Live 2026-08-24 the roster reviewer returned exactly that, and downstream
 * aggregation counted it as a pass.
 *
 * Both halves are asserted here: coverage (every bound tag is mapped) and depth (a declared enum
 * is actually enforced). The tag list is DERIVED from the runner's call sites, never restated,
 * so binding a new tag without mapping it fails this test rather than silently disabling checks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const schema = require(join(ROOT, 'orchestrations/scripts/lib/agent-output-schema.js'));

/** Every tag actually passed to runAgentForJson — read from the source, not listed here. */
const boundTags = (): string[] => {
  const src = readFileSync(RUNNER, 'utf8');
  const m = [...src.matchAll(/runAgentForJson\([^)]*?,\s*[A-Z_]+,\s*'([A-Z_]+)'/gs)];
  return [...new Set(m.map((x) => x[1]))];
};

describe('coverage — every bound tag is known to the validator', () => {
  it('there are bound tags to check', () => {
    expect(boundTags().length).toBeGreaterThan(4);
  });

  it('no tag is bound at a call site but unknown to the validator', () => {
    const known = Object.keys(schema.TAG_TO_TOOL || {});
    const unmapped = boundTags().filter((t) => !known.includes(t));
    expect(unmapped,
      `these tags bind a schema that is never validated — validateTaggedOutput returns ok:true `
      + `for any payload: ${unmapped.join(', ')}`).toEqual([]);
  });
});

describe('depth — a declared enum is enforced', () => {
  it('rejects a verdict outside the enum the tool declares', () => {
    const r = schema.validateTaggedOutput('ROSTER_REVIEW', { verdict: 'warn', findings: [] });
    expect(r.ok, "'warn' validated against an enum that does not contain it").toBe(false);
    expect(String(r.reason || ''), 'the refusal does not name the offending value').toMatch(/warn/);
  });

  it('accepts every value the enum does declare', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const spec = require(RUNNER);
    const legal = spec.TOOL_ROSTER_REVIEW?.parameters?.properties?.verdict?.enum || [];
    expect(legal.length).toBeGreaterThan(1);
    for (const v of legal) {
      const r = schema.validateTaggedOutput('ROSTER_REVIEW', { verdict: v, findings: [] });
      expect(r.ok, `legal verdict '${v}' was rejected: ${r.reason}`).toBe(true);
    }
  });

  it('a field with no declared enum is unaffected', () => {
    // The rule must only bite where a contract actually states a vocabulary.
    const r = schema.validateTaggedOutput('ROSTER_REVIEW',
      { verdict: 'sound', findings: [], somethingElse: 'anything at all' });
    expect(r.ok).toBe(true);
  });
});
