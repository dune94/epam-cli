/**
 * PILLAR 3 — a constraint is COMPILED into an enforcement mechanism, never
 * injected as prompt text.
 *
 * The failure mode this replaces: today the entire self-heal knowledge path ends in
 * `COORDINATOR_PROMPT_AMENDMENT` — text appended to the end of a prompt, trimmed to
 * the last 3 headings past ~16000 chars, with nothing verifying the agent acted on
 * it. Role KBs fare no better: the read path is `tail -n 20` then `tail -n 10`, so
 * at most ten lines of accumulated knowledge ever reach an agent. Instruction
 * softening is not a risk there; it is the design.
 *
 * A compiled constraint instead becomes one of three things the agent cannot ignore:
 *   param      -> a validated field in the agent invocation registry
 *   tool_scope -> narrowed EPAM_ALLOWED_WRITE_PATHS / EPAM_ALLOWED_TOOLS
 *   gate       -> a deterministic check adjudicated by tsc/vitest, failing closed
 *
 * The admission rule is the inverse: if it cannot compile, it is not knowledge we
 * are willing to store. `compile()` must therefore be total over the schema's
 * enforcement kinds — the enumeration test below fails if someone adds a kind to
 * kb_schema.py without a compiler branch.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const compiler = require(join(LIB, 'constraint-compiler.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const c = (enforcement: any, over: any = {}) => ({
  id: 'x', scope: { agent_role: 'typescript-engineer' }, trigger: { signature: 'TS2532' },
  enforcement, reason: 'r', origin_episodes: [], status: 'active', ...over,
});

describe('compile — param becomes a registry field the agent cannot exceed', () => {
  it('emits an env assignment, not prose', () => {
    const out = compiler.compile([c({ kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '12' })]);
    expect(out.env).toEqual({ EPAM_MAX_ITERATIONS: '12' });
    expect(out.promptText ?? '').toBe('');
  });
});

describe('compile — tool_scope narrows what the agent may touch', () => {
  it('sets the write-path allow-list', () => {
    const out = compiler.compile([c({ kind: 'tool_scope', allowed_write_paths: 'src/svc/discount.ts' })]);
    expect(out.env.EPAM_ALLOWED_WRITE_PATHS).toBe('src/svc/discount.ts');
  });

  it('INTERSECTS rather than widens when two constraints both narrow scope', () => {
    // A heal must never be able to grant more access than the agent already had.
    const out = compiler.compile([
      c({ kind: 'tool_scope', allowed_tools: 'read_file,search,bash' }),
      c({ kind: 'tool_scope', allowed_tools: 'read_file,search' }, { id: 'y' }),
    ]);
    expect(out.env.EPAM_ALLOWED_TOOLS.split(',').sort()).toEqual(['read_file', 'search']);
  });
});

describe('compile — gate becomes a deterministic check', () => {
  it('is listed for the gate chain, not appended to a prompt', () => {
    const out = compiler.compile([c({ kind: 'gate', check: 'no-unnarrowed-optional-access' })]);
    expect(out.gates).toEqual(['no-unnarrowed-optional-access']);
    expect(out.promptText ?? '').toBe('');
  });
});

describe('compile — totality over the schema (the admission guarantee)', () => {
  it('every enforcement kind in kb_schema.py has a compiler branch', () => {
    // Derived from the schema itself, so adding a kind without a branch fails here.
    const py = join(LIB, '..', '.venv', 'bin', 'python3');
    const schema = JSON.parse(execFileSync(py, [join(LIB, 'kb_schema.py'), 'json-schema', 'constraint'],
      { encoding: 'utf8' }));
    const defs = schema.$defs ?? schema.definitions ?? {};
    const kinds = Object.values<any>(defs)
      .map(d => d?.properties?.kind?.const)
      .filter(Boolean);
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    expect(compiler.supportedKinds().sort()).toEqual(kinds.sort());
  });

  it('refuses to compile an unknown kind rather than silently dropping it', () => {
    expect(() => compiler.compile([c({ kind: 'note', text: 'be careful' })]))
      .toThrow(/cannot compile|unknown/i);
  });

  it('ignores archived constraints', () => {
    const out = compiler.compile([c({ kind: 'gate', check: 'g' }, { status: 'archived' })]);
    expect(out.gates).toEqual([]);
  });
});

describe('compile — nothing reaches the agent as prose', () => {
  it('the compiled result exposes no free-text channel at all', () => {
    const out = compiler.compile([
      c({ kind: 'gate', check: 'g' }),
      c({ kind: 'param', name: 'A', value: '1' }, { id: 'y' }),
    ]);
    const asText = JSON.stringify(out);
    expect(asText).not.toMatch(/reason|diagnosis|advice|remember/i);
  });
});
