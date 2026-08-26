// EVERY AGENT THE PIPELINE DECLARES MUST BE REACHABLE, BUDGETED AND INVOCABLE.
//
// Written 2026-08-21 after two agents shipped unreachable and one shipped unbudgeted:
//
//   - lib/plan-fidelity-gate.sh had 22 green tests and had NEVER executed: the call site
//     read a committed diff at a point ~1000 lines before the story commits.
//   - The reviewer could not read its own review log, so it approved code carrying the
//     `major` findings it had itself raised one cycle earlier.
//   - codeline-discovery exhausted an UNDECLARED iteration budget (AgentRunner's `?? 20`),
//     reported success, and the run proceeded against the wrong codeline until it was killed.
//
// Every one of those units had passing tests. What nobody tested was whether the thing runs
// at all, with a real budget, reachable from real code. That is what this file asserts, for
// every agent, derived from the declaration rather than a hand-written list — so agent 39 is
// covered without editing this file.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PROFILES = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

/**
 * Every agent the pipeline declares. Derived, never listed.
 *
 * AN AGENT IS A KEY OF A CONTAINER, NOT ANY OBJECT THAT OWNS A BUDGET.
 *
 * This recursed the whole registry and claimed anything carrying ladder/maxIterations/
 * reasoningEffort/_what. `profiles["repro-test-writer"].microQuestion` declares its own
 * iteration and token budget — it is a SUB-BUDGET of one agent for one sub-call, not an agent
 * — so the walk invented an agent named microQuestion and then reported it as having no
 * purpose, no seam, and no call site. Three failures describing a thing that does not exist.
 *
 * The container is `profiles` — agents declared inline, each with its own seam, purpose and
 * budgets, which is what every assertion below is about. `agentSeams` is a different thing: a
 * MAPPING from an agent to a seam it shares with others, so its entries have no _what of their
 * own and their EPAM_SEAM is deliberately not their own name. Enumerating those here reported
 * 54 correctly-configured agents as unwired.
 */
function declaredAgents(): string[] {
  const doc = JSON.parse(readFileSync(PROFILES, 'utf8'));
  return Object.keys(doc.profiles ?? {})
    .filter((k) => !k.startsWith('$') && !k.startsWith('_') && k !== 'defaults')
    .sort();
}

/**
 * The ladder env a REAL run has, produced by the real loader.
 *
 * This used to assemble EPAM_MODEL_LADDER_<TIER> by hand and set no _START variables, so it
 * exercised a shape no run ever has: every agent emitted "declares no startModel", and the
 * ladder-derived iteration budget could not resolve at all. A fixture that invents its own
 * preconditions confirms the code rather than checking it — the same error that made two of
 * this session's fixes inert.
 */
function ladderEnv(): Record<string, string> {
  const settings = join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json');
  if (!existsSync(settings)) return {};
  // NAMED VARIABLES ONLY — never `env | grep EPAM`. That pattern also matches
  // EPAM_API_KEY_ANTHROPIC/OPENAI/GEMINI and would print live credentials into test output
  // and CI logs. The tier names come from the ladder itself, so nothing here is hardcoded.
  const out = spawnSync('bash', ['-c',
    `. "${join(ROOT, 'orchestrations/scripts/lib/model-ladders.sh')}" \
     && export_model_ladders "${settings}" >/dev/null 2>&1; \
     printf 'EPAM_MODEL_LADDER_TIER_ORDER=%s\\n' "\${EPAM_MODEL_LADDER_TIER_ORDER}"; \
     printf 'EPAM_EFFORT_LADDER=%s\\n' "\${EPAM_EFFORT_LADDER}"; \
     printf 'EPAM_MODEL_ITERATIONS=%s\\n' "\${EPAM_MODEL_ITERATIONS}"; \
     for t in \${EPAM_MODEL_LADDER_TIER_ORDER}; do \
       u=\$(printf '%s' "\$t" | tr '[:lower:]-' '[:upper:]_'); \
       eval "printf 'EPAM_MODEL_LADDER_%s=%s\\n' \\"\$u\\" \\"\\\${EPAM_MODEL_LADDER_\$u}\\""; \
       eval "printf 'EPAM_MODEL_LADDER_%s_START=%s\\n' \\"\$u\\" \\"\\\${EPAM_MODEL_LADDER_\${u}_START}\\""; \
     done`,
  ], { encoding: 'utf8' });
  const env: Record<string, string> = {};
  for (const line of (out.stdout || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(eq + 1).trim()) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}
const LADDER = ladderEnv();

/** The invocation gateway, under the ladder a real run loads. */
function seamEnv(agent: string): Record<string, string> {
  const prev = { ...process.env };
  Object.assign(process.env, LADDER);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { seamInvocationEnv } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    return seamInvocationEnv(agent) ?? {};
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
}

/** Non-comment pipeline source, once. */
let CORPUS = '';
function corpus(): string {
  if (CORPUS) return CORPUS;
  const parts: string[] = [];
  (function scan(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|\.git|\/runs|\/logs|archive/.test(p)) scan(p);
      } else if (/\.(sh|js|py)$/.test(e.name)) {
        try {
          parts.push(readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join('\n'));
        } catch { /* unreadable */ }
      }
    }
  })(join(ROOT, 'orchestrations'));
  CORPUS = parts.join('\n');
  return CORPUS;
}

const AGENTS = declaredAgents();

describe('the declaration itself', () => {
  it('the LADDER fixture is real — the loader produced one, not this test', () => {
    // Guards the whole file: with an empty ladder every seam assertion below would pass
    // against nothing, which is precisely how a fixture stops testing anything.
    expect(Object.keys(LADDER).length, 'export_model_ladders produced no env').toBeGreaterThan(3);
    expect(LADDER.EPAM_MODEL_LADDER_TIER_ORDER, 'no tier order from the real loader').toBeTruthy();
    expect(LADDER.EPAM_MODEL_ITERATIONS, 'the ladder declares no iteration budgets').toBeTruthy();
  });

  it('is not vacuous — the pipeline really declares a fleet of agents', () => {
    expect(AGENTS.length).toBeGreaterThan(30);
    expect(AGENTS).toContain('story-writer');
    expect(AGENTS).toContain('team-lead-review');
  });

  it('every agent has a stated purpose, so a reader knows what it is for', () => {
    const doc = JSON.parse(readFileSync(PROFILES, 'utf8'));
    const find = (n: string): any => {
      let hit: any = null;
      (function walk(o: any) { for (const k of Object.keys(o ?? {})) {
        const v = o[k]; if (v && typeof v === 'object') { if (k === n) hit = v; walk(v); } } })(doc);
      return hit;
    };
    const mute = AGENTS.filter((a) => !String(find(a)?._what ?? '').trim());
    expect(mute, `agents with no _what: ${mute.join(', ')}`).toEqual([]);
  });
});

describe('the invocation gateway answers for every agent', () => {
  it.each(AGENTS)('%s — the gateway returns an env naming the seam', (agent) => {
    const env = seamEnv(agent);
    expect(Object.keys(env).length, `${agent}: gateway returned nothing`).toBeGreaterThan(0);
    expect(env.EPAM_SEAM, `${agent}: no EPAM_SEAM — the runner cannot attribute the call`).toBe(agent);
  });

  it.each(AGENTS)('%s — is granted a tool set', (agent) => {
    // An agent with no declared tools silently inherits whatever the run last set. What must
    // hold is that the gateway ANSWERS — not that the answer is a non-empty list. A seam may
    // deliberately declare "none", and requiring a truthy value made the only correct way to
    // express that indistinguishable from having forgotten to configure it.
    expect(seamEnv(agent).EPAM_ALLOWED_TOOLS, `${agent}: no tool grant`).toBeDefined();
  });

  it.each(AGENTS)('%s — its ladder position resolves to a real tier', (agent) => {
    const env = seamEnv(agent);
    // Resolution failure is a WARNING at the seam, so the only evidence is an absent chain.
    const chain = env.EPAM_MODEL_LADDER || env.EPAM_MODEL_LADDER_HIGH || env.EPAM_MODEL;
    expect(chain, `${agent}: no model chain resolved — it will fall back to the run default`).toBeTruthy();
  });
});

describe('every agent is reachable from code', () => {
  it('no agent is declared and never referenced by the pipeline', () => {
    // A profile nothing names cannot be invoked. lib/plan-fidelity-gate.sh shipped in
    // exactly this state and was found only by grepping a live run log for its own name.
    const src = corpus();
    // QUOTED tokens only. A bare word-boundary match let `phase-assessment` be satisfied by
    // the log prefix `[pre-phase-assessment]` — prose, not an invocation. Profile names reach
    // the pipeline as string arguments, so the quote is the signal. A quoted PREFIX counts:
    // prd-change-summarizer is invoked via "prd-change-summarizer-tool"/"-text".
    const unreferenced = AGENTS.filter((a) => {
      const esc = a.replace(/[:.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`["'\`]${esc}(["'\`]|-)`).test(src);
    });
    expect(unreferenced, `declared but never referenced in pipeline code: ${unreferenced.join(', ')}`).toEqual([]);
  });
});

describe('every agent has a bounded iteration budget', () => {
  it('no agent runs on an UNDECLARED iteration budget', () => {
    // AgentRunner falls back to `maxIterations ?? 20`. Until 2026-08-21 an agent that hit
    // that ceiling returned its exhaustion text with exit 0 — which is how discovery
    // selected the wrong repository for an entire run. The budget must be declared, per
    // agent, because 20 is right for none of them by design and for some by accident.
    const missing = AGENTS.filter((a) => !seamEnv(a).EPAM_MAX_ITERATIONS);
    expect(missing, `${missing.length} agent(s) get no budget from the ladder: ${missing.join(', ')}`).toEqual([]);
  });

  it('and an output-token budget', () => {
    const missing = AGENTS.filter((a) => !seamEnv(a).EPAM_MAX_OUTPUT_TOKENS);
    expect(missing, `agents with no output budget: ${missing.join(', ')}`).toEqual([]);
  });
});
