/**
 * PILLAR 2 — response_schema: bind an agent's OUTPUT SPACE as enforcement.
 *
 * This kind exists because of a coverage gap found while removing the prose
 * channels. The analyst's failure classes do not all map to a knob:
 *
 *   max_iterations -> param            (a knob; already expressible)
 *   no_json        -> response_schema  (THIS — previously only expressible as prose)
 *   no_file        -> behaviour, no mechanism yet
 *   invalid_test   -> behaviour, covered by an existing gate
 *
 * Without this, stripping the prose channel would leave `no_json` — an agent that
 * keeps replying with prose or a tool-call wrapper instead of the required
 * structure — with NO enforcement at all. That is the exact trap kb-synthesizer's
 * docstring records about the old analyst: offered a menu that could not express
 * the fix, it answered `none` on 77 of 118 real diagnoses. The menu, not the
 * model, was the defect.
 *
 * A schema is the strongest form of enforcement available: the model cannot emit
 * a non-conforming reply, rather than being asked not to. Verified live on
 * OpenRouter — glm-5.2, glm-5.1 and kimi-k3 all honour json_schema strict mode.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const compiler = require(join(LIB, 'constraint-compiler.js'));

const py = () => {
  const venv = join(LIB, '..', '.venv', 'bin', 'python3');
  try { execFileSync(venv, ['--version']); return venv; } catch { return 'python3'; }
};

function validate(record: unknown) {
  try {
    return JSON.parse(execFileSync(py(), [join(LIB, 'kb_schema.py'), 'validate-constraint'],
      { input: JSON.stringify(record), encoding: 'utf8' }));
  } catch (e: any) {
    return JSON.parse((e.stdout || '{"ok":false,"detail":"crashed"}').trim());
  }
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: { verdict: { type: 'string' }, summary: { type: 'string' } },
  required: ['verdict', 'summary'],
};

const base = {
  id: 'reviewer-must-emit-verdict',
  scope: { agent_role: 'review-agent' },
  trigger: { signature: 'NO_JSON' },
  reason: 'reviewer replied with prose instead of a verdict object',
};

describe('Pillar 2 — response_schema is expressible', () => {
  it('validates a schema-binding rule', () => {
    const r = validate({ ...base,
      enforcement: { kind: 'response_schema', name: 'verdict', schema: VERDICT } });
    expect(r.ok, `schema rejected a legitimate response_schema: ${r.detail}`).toBe(true);
  });

  it('rejects one with no schema — an unenforceable rule must be unconstructable', () => {
    const r = validate({ ...base, enforcement: { kind: 'response_schema', name: 'verdict' } });
    expect(r.ok).toBe(false);
  });
});

describe('Pillar 2 — the compiler carries the schema to the provider seam', () => {
  it('compiles to EPAM_RESPONSE_SCHEMA, carrying name and schema', () => {
    const { env } = compiler.compile([
      { ...base, status: 'active',
        enforcement: { kind: 'response_schema', name: 'verdict', schema: VERDICT } },
    ]);
    expect(env.EPAM_RESPONSE_SCHEMA,
      'no channel to the provider — the output space cannot be bound').toBeTruthy();
    const parsed = JSON.parse(env.EPAM_RESPONSE_SCHEMA);
    expect(parsed.name).toBe('verdict');
    expect(parsed.schema.required).toEqual(['verdict', 'summary']);
  });

  it('carries no free text', () => {
    const { env } = compiler.compile([
      { ...base, status: 'active',
        enforcement: { kind: 'response_schema', name: 'verdict', schema: VERDICT } },
    ]);
    expect(JSON.stringify(env)).not.toMatch(/replied with prose/);
  });

  it('remains TOTAL — every schema kind still has a branch', () => {
    const schema = JSON.parse(execFileSync(py(),
      [join(LIB, 'kb_schema.py'), 'json-schema', 'constraint'], { encoding: 'utf8' }));
    const kinds = Object.values<any>(schema.$defs || schema.definitions || {})
      .map(d => d?.properties?.kind?.const).filter(Boolean);
    expect(kinds).toContain('response_schema');
    expect(compiler.supportedKinds().sort()).toEqual(kinds.sort());
  });
});
