/**
 * PILLAR 3 — verification hashes over the enforced state.
 *
 * `apply` compiles constraints into env exports. Between that moment and the
 * agent actually running, the values can drift: a wrapper re-exports a default, a
 * subshell is spawned with a scrubbed environment, a later `export` overwrites a
 * knob. The failure is silent — the agent runs UNCONSTRAINED while the pipeline
 * believes a healed rule is in force, which is worse than never having applied it,
 * because the KB then records a "fix that didn't work" and ages the rule out.
 *
 * Evidence this is real, from this pipeline: B28 was an env var simply not set at
 * a call site; B29 was config rewritten underneath a running system; and there is
 * a standing rule against hand-assembling EPAM_* env at call sites because it
 * drifts.
 *
 * SCOPED DELIBERATELY. The digest covers ONLY the variables the compiler
 * produced, listed in KB_STATE_VARS — never the whole environment. Child shells
 * legitimately add and mutate variables; digesting everything would fire
 * constantly, and an abort mechanism that cries wolf gets disabled, which is how
 * safety features die.
 *
 * Absence of state is not drift: with nothing applied there is nothing to verify,
 * and verification must pass silently rather than block every run without a KB.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const KB_CLI = join(LIB, 'kb-cli.js');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function stubRunner(json: string) {
  const d = mkdtempSync(join(tmpdir(), 'kb-dig-run-')); dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'J'\n${json}\nJ\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A store holding one applied constraint, plus the shell exports it compiles to. */
function appliedStore() {
  const root = mkdtempSync(join(tmpdir(), 'kb-dig-')); dirs.push(root);
  const env = { ...process.env, KB_ROOT: root } as Record<string, string>;
  for (const id of ['e1', 'e2']) {
    execFileSync(NODE20, [KB_CLI, 'record', '--agent-role', 'impl-agent', '--story', 'S', '--id', id],
      { input: "src/a.ts(1,1): error TS2532: Object is possibly 'undefined'.", encoding: 'utf8', env });
  }
  execFileSync(NODE20, [KB_CLI, 'synthesize-auto', '--agent-role', 'impl-agent', '--signature', 'TS2532'],
    { encoding: 'utf8', env: { ...env, AI_RUNNER_CMD: stubRunner(JSON.stringify({
      enforcement: { kind: 'param', name: 'EPAM_REASONING_EFFORT', value: 'high' }, reason: 'r' })) } });
  const exports = execFileSync(NODE20,
    [KB_CLI, 'apply', '--agent-role', 'impl-agent', '--signatures', 'TS2532'],
    { encoding: 'utf8', env }).trim();
  return { root, env, exports };
}

/** Run `verify-state` in a shell that first evaluates the given exports. */
function verify(root: string, exportsScript: string) {
  // 2>&1: the drift detail goes to stderr, which execFileSync does not return on
  // success — without this the assertion would be checking an empty string.
  const script = `set -uo pipefail\n${exportsScript}\n${NODE20} ${KB_CLI} verify-state 2>&1; echo "RC=$?"`;
  try {
    const out = execFileSync('bash', ['-c', script],
      { encoding: 'utf8', env: { ...process.env, KB_ROOT: root } });
    return { out, rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? 0) };
  } catch (e: any) {
    const out = (e.stdout || '') + (e.stderr || '');
    return { out, rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? 1) };
  }
}

describe('Pillar 3 — the compiled surface is digested', () => {
  it('apply emits a digest and the list of variables it covers', () => {
    const { exports } = appliedStore();
    expect(exports, 'no digest emitted — drift cannot be detected').toMatch(/export KB_STATE_DIGEST=/);
    expect(exports, 'no variable list — the verifier cannot know what it is checking')
      .toMatch(/export KB_STATE_VARS=/);
    expect(exports).toMatch(/EPAM_REASONING_EFFORT/);
  });

  it('verifies clean immediately after apply', () => {
    const { root, exports } = appliedStore();
    const { rc } = verify(root, exports);
    expect(rc, 'a freshly applied surface failed its own verification').toBe(0);
  });
});

describe('Pillar 3 — drift is caught, loudly', () => {
  it('fails when an enforced variable has been STRIPPED', () => {
    const { root, exports } = appliedStore();
    const { rc, out } = verify(root, `${exports}\nunset EPAM_REASONING_EFFORT`);
    expect(rc, 'a stripped constraint went undetected — the agent runs unconstrained').not.toBe(0);
    expect(out).toMatch(/EPAM_REASONING_EFFORT|drift|mismatch/i);
  });

  it('fails when an enforced value has been OVERWRITTEN', () => {
    const { root, exports } = appliedStore();
    const { rc } = verify(root, `${exports}\nexport EPAM_REASONING_EFFORT=low`);
    expect(rc, 'a later export silently replaced a healed constraint').not.toBe(0);
  });
});

describe('Pillar 3 — the seam every agent call passes through refuses on drift', () => {
  it('ai-run.sh verifies enforced state before invoking', () => {
    const src = readFileSync(join(LIB, '..', 'llm-handler.sh'), 'utf8');
    expect(src, 'the one door every agent call goes through does not check for drift')
      .toMatch(/kb_verify_state/);
    expect(src, 'drift is detected but not acted on — the agent would still run unconstrained')
      .toMatch(/ABORT|exit 3/);
  });

  it('the check is inert without applied constraints', () => {
    const src = readFileSync(join(LIB, '..', 'llm-handler.sh'), 'utf8');
    // Guarded on KB_STATE_DIGEST so a run with no KB state is untouched.
    expect(src).toMatch(/if \[ -n "\$\{KB_STATE_DIGEST:-\}" \]/);
  });

  it('kb-apply.sh exposes the verifier to the shell pipeline', () => {
    expect(readFileSync(join(LIB, 'kb-apply.sh'), 'utf8')).toMatch(/kb_verify_state\(\)/);
  });
});

describe('Pillar 3 — absence of state is not drift', () => {
  it('passes silently when nothing was applied', () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-dig-empty-')); dirs.push(root);
    const { rc } = verify(root, 'true');
    expect(rc, 'verification blocks runs that have no KB state at all').toBe(0);
  });
});
