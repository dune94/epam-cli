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
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PROFILES = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

/** Every agent the pipeline declares. Derived, never listed. */
function declaredAgents(): string[] {
  const doc = JSON.parse(readFileSync(PROFILES, 'utf8'));
  const names: string[] = [];
  (function walk(o: any) {
    for (const k of Object.keys(o ?? {})) {
      const v = o[k];
      if (v && typeof v === 'object') {
        if (v.ladder || v.maxIterations || v.reasoningEffort || v._what) names.push(k);
        walk(v);
      }
    }
  })(doc);
  return [...new Set(names)].filter((n) => n !== 'defaults').sort();
}

/** The invocation gateway, under a realistic three-tier project. */
function seamEnv(agent: string): Record<string, string> {
  const prev = { ...process.env };
  Object.assign(process.env, {
    EPAM_MODEL_LADDER_TIER_ORDER: 'medium high highest',
    EPAM_MODEL_LADDER_MEDIUM: 'm1,m2',
    EPAM_MODEL_LADDER_HIGH: 'h1,h2',
    EPAM_MODEL_LADDER_HIGHEST: 'x1,x2',
  });
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
    // An agent with no declared tools silently inherits whatever the run last set.
    expect(seamEnv(agent).EPAM_ALLOWED_TOOLS, `${agent}: no tool grant`).toBeTruthy();
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
    expect(missing, `${missing.length} agent(s) inherit AgentRunner's default of 20: ${missing.join(', ')}`).toEqual([]);
  });

  it('and an output-token budget', () => {
    const missing = AGENTS.filter((a) => !seamEnv(a).EPAM_MAX_OUTPUT_TOKENS);
    expect(missing, `agents with no output budget: ${missing.join(', ')}`).toEqual([]);
  });
});
