// THE GATEWAY BUILT TO BE "THE ONE DOOR FOR EVERY LLM AGENT INVOCATION" HAD ZERO CALL SITES.
//
// lib/agent-invoke.sh is complete: it resolves a role against agents/invocation-profiles.json,
// refuses an unknown role, refuses a profile missing a required key, and hands the runner a budget
// nobody had to remember. Its own header says why:
//
//   "Silently falling back to a default is what let a reviewer run at 4096 tokens for months
//    without anyone noticing."
//
// Nothing called it. Every seam kept setting the budget itself:
//
//   EPAM_MAX_ITERATIONS="${REVIEW_MAX_ITERATIONS:-25}"
//   EPAM_REASONING_EFFORT="${REVIEW_REASONING_EFFORT:-high}"
//   EPAM_MAX_OUTPUT_TOKENS="${REVIEW_MAX_OUTPUT_TOKENS:-32768}"
//
// — the exact `${VAR:-default}` shape the gateway exists to remove. A default written at the call
// site is a value nobody chose, and it is invisible the day it is wrong.
//
// team-lead-review is wired first because it is where this week's worst defect lived: the reviewer
// returned 292 output tokens as an empty string, and the run acted on a verdict nobody wrote.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GATEWAY = join(SCRIPTS, 'lib/agent-invoke.sh');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const REVIEW = join(SCRIPTS, 'team-lead-review.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const profiles = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

/** A runner that records the environment it was handed, instead of calling a model. */
function stubRunner(): { path: string; envFile: string } {
  const d = mkdtempSync(join(tmpdir(), 'gateway-')); made.push(d);
  const envFile = join(d, 'env.txt');
  const path = join(d, 'runner.sh');
  // Reads the variables directly rather than shelling to `env`, which produces nothing here.
  const vars = ['AGENT_INVOKE_ROLE', 'AI_MODEL', 'AI_PROVIDER', 'EPAM_MAX_OUTPUT_TOKENS',
    'EPAM_MAX_ITERATIONS', 'EPAM_REASONING_EFFORT', 'EPAM_TEMPERATURE', 'EPAM_ALLOWED_TOOLS',
    'AI_GATE_ALLOW_TOOLS', 'ORCH_JSON_RESULT', 'EPAM_ALLOWED_WRITE_PATHS',
    'EPAM_MAX_TOOL_CALLS'];
  const dump = vars.map((v) => `echo "${v}=\${${v}:-}"`).join('\n');
  writeFileSync(path,
    `#!/usr/bin/env bash\n{\n${dump}\n} > ${JSON.stringify(envFile)}\necho "AGENT SAID SOMETHING"\n`,
    { mode: 0o755 });
  return { path, envFile };
}

/** Invoke a role through the real gateway against a stub runner. */
function invoke(role: string, args: string[] = []): { out: string; status: number; env: Record<string, string> } {
  const { path, envFile } = stubRunner();
  const r = spawnSync('bash', ['-c',
    `set -uo pipefail
     source ${JSON.stringify(GATEWAY)}
     printf '%s' "a prompt" | invoke_agent ${role} --runner ${JSON.stringify(path)} ${args.join(' ')}`,
  ], { encoding: 'utf8' });
  let env: Record<string, string> = {};
  try {
    env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { /* the runner never ran */ }
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status ?? -1, env };
}

describe('the gateway hands the runner what the registry declares', () => {
  it('the budget comes from the profile, not from the call site', () => {
    const p = profiles().profiles['team-lead-review'];
    const { env } = invoke('team-lead-review');
    expect(env.EPAM_MAX_OUTPUT_TOKENS).toBe(String(p.maxOutputTokens));
    expect(env.EPAM_MAX_ITERATIONS).toBe(String(p.maxIterations));
    expect(env.EPAM_REASONING_EFFORT).toBe(p.reasoningEffort);
  });

  it('including the TOOL-CALL budget, the last piece still written at a call site', () => {
    // team-lead-review.sh set EPAM_MAX_TOOL_CALLS itself, with the comment that it and the
    // iteration cap "bound different failures, so both are set" — which is the argument for the
    // registry owning both, not for the call site owning one of them.
    const p = profiles().profiles['team-lead-review'];
    expect(p.maxToolCalls, 'the profile does not declare a tool-call budget').toBeGreaterThan(0);
    expect(invoke('team-lead-review').env.EPAM_MAX_TOOL_CALLS).toBe(String(p.maxToolCalls));
  });

  it('and names the role, so cost and KB rows can be attributed', () => {
    expect(invoke('team-lead-review').env.AGENT_INVOKE_ROLE).toBe('team-lead-review');
  });

  it('the runner really ran — otherwise every assertion above reads an empty file', () => {
    expect(invoke('team-lead-review').out).toContain('AGENT SAID SOMETHING');
  });
});

describe('a role it cannot serve is refused, never defaulted', () => {
  it('an unknown role aborts', () => {
    const r = invoke('no-such-role-anywhere');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/unknown agent role/);
  });

  it('a profile missing a required key aborts rather than running at provider defaults', () => {
    const d = mkdtempSync(join(tmpdir(), 'reg-')); made.push(d);
    const reg = join(d, 'profiles.json');
    writeFileSync(reg, JSON.stringify({ defaults: {}, profiles: { thin: { _what: 'declares nothing' } } }));
    const { path } = stubRunner();
    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       AGENT_PROFILES_REGISTRY=${JSON.stringify(reg)}
       source ${JSON.stringify(GATEWAY)}
       AGENT_PROFILES_REGISTRY=${JSON.stringify(reg)}
       printf '%s' p | invoke_agent thin --runner ${JSON.stringify(path)}`,
    ], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect((r.stdout || '') + (r.stderr || '')).toMatch(/missing required parameter/);
  });
});

describe('per-site values still belong to the caller', () => {
  it('model and provider are passed through', () => {
    const { env } = invoke('team-lead-review', ['--model', 'z-ai/glm-5.2', '--provider', 'qwen']);
    expect(env.AI_MODEL).toBe('z-ai/glm-5.2');
    expect(env.AI_PROVIDER).toBe('qwen');
  });

  it('the TOOL GRANT comes from the profile, resolved for this codeline', () => {
    // The registry has declared "toolGrant": "execute" for this role all along and the gateway
    // ignored it, so the call site wrote a literal list instead:
    //
    //   --tools "bash,read_file,list_files,search${_review_plugin_tools:+,...}"
    //
    // lib/agent-tools.js already resolves a grant kind into the read-only floor PLUS the plugin
    // tools THIS codeline provisioned, plus whatever the kind adds. The literal was a worse answer
    // to a question already answered — and it hardcoded four tool names.
    const { env } = invoke('team-lead-review', ['--codeline', ROOT]);
    expect(env.EPAM_ALLOWED_TOOLS, 'the declared grant reaches nothing').toBeTruthy();
    expect(env.EPAM_ALLOWED_TOOLS.split(','), 'the execute grant must add bash').toContain('bash');
    expect(env.EPAM_ALLOWED_TOOLS.split(',').length,
      'fewer tools than the floor — the grant was not really resolved').toBeGreaterThan(3);
  });

  it('an unknown grant kind aborts rather than quietly handing over the floor', () => {
    const d = mkdtempSync(join(tmpdir(), 'reg2-')); made.push(d);
    const reg = join(d, 'profiles.json');
    writeFileSync(reg, JSON.stringify({
      defaults: { maxOutputTokens: 1, maxIterations: 1, reasoningEffort: 'low', timeoutSecs: 5, captureCost: true },
      profiles: { odd: { toolGrant: 'no-such-grant' } },
    }));
    const { path } = stubRunner();
    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       export AGENT_PROFILES_REGISTRY=${JSON.stringify(reg)}
       source ${JSON.stringify(GATEWAY)}
       printf '%s' p | invoke_agent odd --runner ${JSON.stringify(path)} --codeline ${JSON.stringify(ROOT)}`,
    ], { encoding: 'utf8' });
    expect(r.status, 'a mis-declared grant ran anyway').not.toBe(0);
    expect((r.stdout || '') + (r.stderr || '')).toMatch(/unknown tool grant|tool grant/i);
  });

  it('and an explicit --tools still overrides, for a genuinely dynamic grant', () => {
    // team-lead-review appends whatever plugin tools the codeline provisioned, which the registry
    // cannot know. Routing and dynamic grants stay with the caller by design; only the budget is
    // centralised.
    const { env } = invoke('team-lead-review', ['--tools', 'bash,read_file,codegraph_query']);
    expect(env.EPAM_ALLOWED_TOOLS).toBe('bash,read_file,codegraph_query');
    expect(env.AI_GATE_ALLOW_TOOLS).toBe('1');
  });
});

describe('the door is actually used', () => {
  it('team-lead-review.sh invokes through the gateway', () => {
    const src = readFileSync(REVIEW, 'utf8');
    expect(src, 'the one door still has no call sites').toMatch(/invoke_agent\s+team-lead-review/);
    expect(src).toMatch(/agent-invoke\.sh/);
  });

  it('and no longer writes a literal tool list either', () => {
    const src = readFileSync(REVIEW, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src, 'the call site still hardcodes tool names the registry already declares')
      .not.toMatch(/bash,read_file,list_files,search/);
  });

  it('and no longer writes the execution budget at the call site', () => {
    const src = readFileSync(REVIEW, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const v of ['EPAM_MAX_OUTPUT_TOKENS', 'EPAM_MAX_ITERATIONS', 'EPAM_REASONING_EFFORT',
      'EPAM_MAX_TOOL_CALLS']) {
      expect(src, `${v} is still set at the call site — the registry is not the source of truth`)
        .not.toMatch(new RegExp(`${v}=`));
    }
  });

  it('the gateway is no longer a function nothing reaches', () => {
    const calls: string[] = [];
    for (const f of require('node:fs').readdirSync(SCRIPTS).filter((x: string) => x.endsWith('.sh'))) {
      const s = readFileSync(join(SCRIPTS, f), 'utf8');
      s.split('\n').forEach((l) => {
        if (/^\s*#/.test(l)) return;
        if (/(^|[\s;&|(`$])invoke_agent\s/.test(l)) calls.push(f);
      });
    }
    expect([...new Set(calls)], 'zero seams go through the one door').not.toEqual([]);
  });
});
