/**
 * PILLAR 1 — pre-flight guard: a constraint about a COMMAND is enforced before
 * the command runs, not diagnosed after it fails.
 *
 * The other enforcement kinds bind knobs (param) or reach (tool_scope). Neither
 * can express "this agent keeps running a command it must not run" — the class
 * that produced DO_NOT_USE_SUDO / --no-verify style failures. Without a mechanism
 * for it, such a lesson can only ever be prose, and prose is banned as a self-heal
 * channel.
 *
 * DELIBERATELY SUBSTRING, NOT AST. A full bash parser is its own failure domain
 * (command substitution, here-docs, quoting) and a half-correct parser gives false
 * confidence — which is precisely the silent-failure class being removed from this
 * pipeline. Literal substring predicates are ~0ms, have no grammar edge cases, and
 * cover the real failures.
 *
 * The rejection is returned as a TOOL RESULT, not injected into a prompt. That is
 * in-band, deterministic, tied to the specific call, and verifiable — the same
 * category as an OS permission error. Without it an agent hits an invisible wall
 * and retries blindly, which is its own failure mode.
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
    const out = execFileSync(py(), [join(LIB, 'kb_schema.py'), 'validate-constraint'],
      { input: JSON.stringify(record), encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e: any) {
    return JSON.parse((e.stdout || '{"ok":false,"detail":"crashed"}').trim());
  }
}

const base = {
  id: 'no-sudo-impl',
  scope: { agent_role: 'impl-agent' },
  trigger: { signature: 'EPERM' },
  reason: 'agent repeatedly invoked sudo, which is unavailable in the sandbox',
};

describe('Pillar 1 — pre_exec_block is expressible as a constraint', () => {
  it('validates a command-blocking rule', () => {
    const r = validate({ ...base, enforcement: { kind: 'pre_exec_block', pattern: 'sudo ' } });
    expect(r.ok, `schema rejected a legitimate pre_exec_block: ${r.detail}`).toBe(true);
  });

  it('rejects a block with no pattern — an unenforceable rule must be unconstructable', () => {
    const r = validate({ ...base, enforcement: { kind: 'pre_exec_block' } });
    expect(r.ok).toBe(false);
  });

  it('still rejects advice-shaped enforcement', () => {
    const r = validate({ ...base, enforcement: { kind: 'advice', text: 'be careful' } });
    expect(r.ok).toBe(false);
  });
});

describe('Pillar 1 — the compiler carries blocks to the execution seam', () => {
  it('compiles a pre_exec_block into the env channel, with its id', () => {
    const { env } = compiler.compile([
      { ...base, status: 'active', enforcement: { kind: 'pre_exec_block', pattern: 'sudo ' } },
    ]);
    expect(env.KB_PRE_EXEC_BLOCKS,
      'no channel to the Bash tool — the rule cannot be enforced anywhere').toBeTruthy();
    const blocks = JSON.parse(env.KB_PRE_EXEC_BLOCKS);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].pattern).toBe('sudo ');
    // The id must survive: the rejection names the gate that fired.
    expect(blocks[0].id).toBe('no-sudo-impl');
  });

  it('carries no free text — the reason must never cross into the agent', () => {
    const { env } = compiler.compile([
      { ...base, status: 'active', enforcement: { kind: 'pre_exec_block', pattern: 'sudo ' } },
    ]);
    expect(JSON.stringify(env)).not.toMatch(/repeatedly invoked sudo/);
  });

  it('ignores archived rules', () => {
    const { env } = compiler.compile([
      { ...base, status: 'archived', enforcement: { kind: 'pre_exec_block', pattern: 'sudo ' } },
    ]);
    expect(env.KB_PRE_EXEC_BLOCKS).toBeFalsy();
  });

  it('remains TOTAL — every schema kind has a branch', () => {
    const schema = JSON.parse(execFileSync(py(), [join(LIB, 'kb_schema.py'), 'json-schema', 'constraint'],
      { encoding: 'utf8' }));
    const defs = schema.$defs || schema.definitions || {};
    const kinds = Object.values<any>(defs)
      .map(d => d?.properties?.kind?.const)
      .filter(Boolean);
    expect(kinds).toContain('pre_exec_block');
    expect(compiler.supportedKinds().sort()).toEqual(kinds.sort());
  });
});
