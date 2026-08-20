// THE AGENT THAT DIAGNOSES A FAILURE COULD NOT LOOK AT ANYTHING.
//
// agent-attempt-analyst.sh invokes the failure analyst like this:
//
//     EPAM_MAX_ITERATIONS=1 \
//     EPAM_REASONING_EFFORT="${AGENT_ANALYST_REASONING_EFFORT:-high}" \
//     EPAM_MAX_OUTPUT_TOKENS="${AGENT_ANALYST_MAX_OUTPUT_TOKENS:-32768}" \
//     bash "$AI_RUNNER_CMD" ...
//
// No EPAM_ALLOWED_TOOLS. No AI_GATE_ALLOW_TOOLS. The agent asked to work out WHY an attempt failed
// gets the prompt and nothing else — it cannot read the file that failed, search for the symbol, or
// run the check that reported the failure. It diagnoses from a description of the evidence.
//
// Its profile has declared `"toolGrant": "execute"` the whole time. Nothing read it, because
// nothing went through lib/agent-invoke.sh — the gateway that resolves a grant. So the declaration
// and the invocation disagreed, and the invocation won silently.
//
// The budget is the same story one field over: three ${VAR:-default} literals at the call site,
// duplicating a profile that already states them.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GATEWAY = join(SCRIPTS, 'lib/agent-invoke.sh');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const ANALYST = join(SCRIPTS, 'agent-attempt-analyst.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const profile = (role: string) => JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles[role];

function stubRunner(): { path: string; envFile: string } {
  const d = mkdtempSync(join(tmpdir(), 'analyst-')); made.push(d);
  const envFile = join(d, 'env.txt');
  const path = join(d, 'runner.sh');
  const vars = ['AGENT_INVOKE_ROLE', 'EPAM_MAX_OUTPUT_TOKENS', 'EPAM_MAX_ITERATIONS',
    'EPAM_REASONING_EFFORT', 'EPAM_ALLOWED_TOOLS', 'AI_GATE_ALLOW_TOOLS', 'EPAM_TEMPERATURE'];
  const dump = vars.map((v) => `echo "${v}=\${${v}:-}"`).join('\n');
  writeFileSync(path, `#!/usr/bin/env bash\n{\n${dump}\n} > ${JSON.stringify(envFile)}\necho DIAGNOSIS\n`,
    { mode: 0o755 });
  return { path, envFile };
}

function invoke(role: string, args: string[] = []): Record<string, string> {
  const { path, envFile } = stubRunner();
  spawnSync('bash', ['-c',
    `set -uo pipefail
     source ${JSON.stringify(GATEWAY)}
     printf '%s' "why did it fail" | invoke_agent ${role} --runner ${JSON.stringify(path)} ${args.join(' ')}`,
  ], { encoding: 'utf8' });
  try {
    return Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return {}; }
}

describe('the analyst can look at the thing it is diagnosing', () => {
  for (const role of ['agent-failure-analyst', 'impl-failure-analyst']) {
    it(`${role} receives the tools its profile declares`, () => {
      const p = profile(role);
      expect(p.toolGrant, `${role} declares no tool grant`).toBeTruthy();
      const env = invoke(role, ['--codeline', ROOT]);
      expect(env.EPAM_ALLOWED_TOOLS, `${role} is handed no tools at all`).toBeTruthy();
      expect(env.AI_GATE_ALLOW_TOOLS, 'the tool gate is not opened, so the grant is filtered away').toBe('1');
    });

    it(`${role} can at least READ and SEARCH`, () => {
      const tools = (invoke(role, ['--codeline', ROOT]).EPAM_ALLOWED_TOOLS || '').split(',');
      expect(tools, 'cannot read the file that failed').toContain('read_file');
      expect(tools, 'cannot search for the symbol').toContain('search');
    });

    it(`${role} gets the budget from its profile, not from a call-site default`, () => {
      const p = profile(role);
      const env = invoke(role);
      expect(env.EPAM_MAX_OUTPUT_TOKENS).toBe(String(p.maxOutputTokens));
      expect(env.EPAM_REASONING_EFFORT).toBe(p.reasoningEffort);
    });
  }

  it('and an execute grant really adds bash — otherwise "execute" means nothing', () => {
    const tools = (invoke('agent-failure-analyst', ['--codeline', ROOT]).EPAM_ALLOWED_TOOLS || '').split(',');
    expect(tools).toContain('bash');
  });
});

describe('the analyst script goes through the door', () => {
  const src = () => readFileSync(ANALYST, 'utf8');

  it('invokes through the gateway', () => {
    expect(src(), 'the analyst still calls the runner directly')
      .toMatch(/invoke_agent\s+agent-failure-analyst/);
    expect(src()).toMatch(/agent-invoke\.sh/);
  });

  it('and no longer writes the budget at the call site', () => {
    const s = src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const v of ['EPAM_MAX_OUTPUT_TOKENS', 'EPAM_MAX_ITERATIONS', 'EPAM_REASONING_EFFORT']) {
      expect(s, `${v} is still set here — the profile is not the source of truth`)
        .not.toMatch(new RegExp(`${v}=`));
    }
  });

  it('and still keeps the runner stderr, which is the only evidence of WHY self-heal failed', () => {
    // Both call sites used to discard it. Wiring the gateway must not quietly drop it again.
    expect(src()).toMatch(/_analyst_err/);
  });
});
