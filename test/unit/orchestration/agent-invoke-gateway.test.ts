/**
 * The agent-invocation Gateway (lib/agent-invoke.sh) + its profile Registry.
 *
 * WHAT CLASS OF BUG THIS EXISTS TO CATCH — "a call site forgot a parameter".
 *
 * Six instances reached production, each found by a live run rather than a test,
 * because every invocation site hand-assembled its own env bundle and each omitted
 * a DIFFERENT subset:
 *   - team-lead-review.sh: high reasoning effort, no output budget → inherited
 *     AgentRunner's 4096 default → glm-5.2 spent the whole allowance in <think> and
 *     returned 169 bytes of truncated prose. The run blocked on "review output
 *     unparseable" (2026-07-25). A non-reasoning model fits under 4096, which is
 *     exactly why testing the reviewer standalone on haiku showed it PASSING.
 *   - post-impl-tc-writer.sh: set EPAM_MAX_TOKENS=8192 — a name NOTHING reads. It
 *     had been running at 4096 the whole time while appearing configured.
 *   - agent-attempt-analyst.sh, code-review-cycle.sh, contextualize-stories.sh: no budget.
 *   - 13 of 15 sites never set ORCH_JSON_RESULT, so per-agent cost was invisible.
 *   - No shell site set a timeout at all.
 *
 * These are behavioural tests: they RUN the gateway against a stub runner and assert
 * on the env the agent actually received. A source-text test would pass on a script
 * that sets the variable somewhere unreachable — which is precisely the EPAM_MAX_TOKENS
 * failure mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATEWAY = join(__dirname, '../../../orchestrations/scripts/lib/agent-invoke.sh');
const REGISTRY = join(__dirname, '../../../orchestrations/agents/invocation-profiles.json');

/** Below this a reasoning model can consume its whole budget in <think>. */
const REASONING_FLOOR = 8192;

let dir: string;
let stub: string;
let envDump: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-invoke-'));
  envDump = join(dir, 'env.txt');
  stub = join(dir, 'stub-runner.sh');
  // Stands in for ai-run.sh: records the env it was handed, echoes the prompt back.
  // `export -p` (a bash BUILTIN), never `env`: this machine has a ~/.local/bin/env
  // that shadows coreutils and silently swallows its command. Using `env` here is
  // what made every assertion below read `undefined` while the gateway worked fine.
  writeFileSync(stub, `#!/usr/bin/env bash
export -p | sed -n 's/^declare -x //p' > ${JSON.stringify(envDump)}
echo "args: $*" >> ${JSON.stringify(envDump)}
cat > /dev/null
echo "STUB_OK"
`);
  chmodSync(stub, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run invoke_agent for real and return {stdout, exitCode, env seen by the runner}. */
function invoke(role: string, extraArgs = '', env: Record<string, string> = {}) {
  if (existsSync(envDump)) rmSync(envDump);
  let stdout = '', code = 0;
  try {
    stdout = execFileSync('bash', ['-c',
      `set -uo pipefail
       source ${JSON.stringify(GATEWAY)}
       printf 'a prompt' | invoke_agent ${role} --runner ${JSON.stringify(stub)} ${extraArgs}`,
    ], { encoding: 'utf8', env: { ...process.env, ...env } });
  } catch (e: any) {
    stdout = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  const seen: Record<string, string> = {};
  if (existsSync(envDump)) {
    for (const line of readFileSync(envDump, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) seen[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
    }
  }
  return { stdout, code, seen };
}

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

describe('Gateway — a role supplies the full parameter set', () => {
  it('the reviewer gets a budget that fits <think> plus a verdict (the live 169-byte bug)', () => {
    const { seen } = invoke('team-lead-review');
    expect(Number(seen.EPAM_MAX_OUTPUT_TOKENS)).toBeGreaterThanOrEqual(REASONING_FLOOR);
  });

  it('every registered role receives all five required parameters', () => {
    for (const role of Object.keys(registry().profiles)) {
      const { seen } = invoke(role);
      for (const k of ['EPAM_MAX_OUTPUT_TOKENS', 'EPAM_MAX_ITERATIONS', 'EPAM_REASONING_EFFORT']) {
        expect(seen[k], `${role} did not receive ${k}`).toBeTruthy();
      }
    }
  });

  it('no role is dispatched below the reasoning floor', () => {
    for (const role of Object.keys(registry().profiles)) {
      const { seen } = invoke(role);
      expect(Number(seen.EPAM_MAX_OUTPUT_TOKENS), `${role} budget starves a reasoning model`)
        .toBeGreaterThanOrEqual(REASONING_FLOOR);
    }
  });

  it('every role captures cost (13 of 15 sites previously did not)', () => {
    for (const role of Object.keys(registry().profiles)) {
      const { seen } = invoke(role);
      expect(seen.ORCH_JSON_RESULT, `${role} would report no cost`).toBeTruthy();
    }
  });

  it('the caller-supplied json-result path is honoured over the generated one', () => {
    const p = join(dir, 'mine.json');
    const { seen } = invoke('team-lead-review', `--json-result ${JSON.stringify(p)}`);
    expect(seen.ORCH_JSON_RESULT).toBe(p);
  });
});

describe('Gateway — fail-fast beats a silent default', () => {
  it('an unknown role ABORTS rather than running at provider defaults', () => {
    const { stdout, code } = invoke('no-such-role');
    expect(code).not.toBe(0);
    expect(stdout).toMatch(/unknown agent role/);
  });

  it('a profile missing a required key ABORTS and names the key', () => {
    const bad = join(dir, 'bad-registry.json');
    writeFileSync(bad, JSON.stringify({
      defaults: { captureCost: true },                    // no maxOutputTokens anywhere
      profiles: { broken: { reasoningEffort: 'high', maxIterations: 1, timeoutSecs: 60 } },
    }));
    const { stdout, code } = invoke('broken', '', { AGENT_PROFILES_REGISTRY: bad });
    expect(code).not.toBe(0);
    expect(stdout).toMatch(/missing required parameter/);
    expect(stdout).toMatch(/maxOutputTokens/);
  });
});

describe('Gateway — routing stays with the caller', () => {
  it('passes the caller model and provider through to the runner', () => {
    const { seen } = invoke('team-lead-review', '--model z-ai/glm-5.2 --provider qwen');
    expect(seen.AI_MODEL).toBe('z-ai/glm-5.2');
    expect(seen.AI_PROVIDER).toBe('qwen');
  });

  it('tags the invocation with its role so logs can attribute it', () => {
    const { seen } = invoke('cpa-gate');
    expect(seen.AGENT_INVOKE_ROLE).toBe('cpa-gate');
  });
});

describe('Gateway — per-role override without editing the registry', () => {
  it('AGENT_INVOKE_<ROLE>_MAX_OUTPUT_TOKENS wins', () => {
    const { seen } = invoke('cpa-gate', '', { AGENT_INVOKE_CPA_GATE_MAX_OUTPUT_TOKENS: '31337' });
    expect(seen.EPAM_MAX_OUTPUT_TOKENS).toBe('31337');
  });
});

describe('Registry — hygiene', () => {
  it('is valid JSON with defaults covering every required key', () => {
    const r = registry();
    for (const k of ['maxOutputTokens', 'maxIterations', 'reasoningEffort', 'timeoutSecs', 'captureCost']) {
      expect(r.defaults[k], `defaults.${k} missing`).toBeDefined();
    }
  });

  it('every profile documents what its agent does', () => {
    for (const [role, p] of Object.entries<any>(registry().profiles)) {
      expect(p._what, `${role} has no _what`).toBeTruthy();
    }
  });
});
