/**
 * ONE LADDER HANDLER, FOR EVERY CONSUMER — AND THE CONSUMER LIST IS DERIVED, NOT LISTED.
 *
 * WRITTEN BEFORE THE CONVERSION. RED WHEN WRITTEN.
 *
 * lib/agent-ladder.sh is the handler: it reads the tier the agent's ARCHETYPE declares, reads the
 * chain for that tier from the environment, and steps one rung per recorded failure. It names no
 * model and no tier, which is why it can serve every agent.
 *
 * Measured 2026-08-14: eight scripts carried their own ladder logic and only one touched the
 * shared handler. Eleven scripts carried a literal model name as a fallback default. The cost is
 * visible in brownfield-repro-test-writer.sh, which asks the seam for its ladder at line 61 and
 * discards the answer at line 284:
 *
 *     _base_model="${SPEC_MODE_SPECKIT_MODEL:-${ESCALATION_MODEL_HIGH:-z-ai/glm-5.1}}"
 *
 * so the tier its archetype declares selects nothing, and editing that declaration changes no
 * model at all.
 *
 * NOTHING IN THIS FILE NAMES AN AGENT, A SCRIPT, A MODEL OR A VENDOR:
 *
 *   the consumers    every seam that declares a `ladder` in invocation-profiles.json, matched to
 *                    the script that announces itself with seam_ladder_export "<seam>". The code
 *                    states the mapping; this test reads it.
 *   the models       every `from`/`to` in the project's declared modelLadder. A "model literal"
 *                    is a name the project itself declares as a model — discovered, never listed.
 *
 * So a new agent, a new script or a new vendor is covered the moment it is declared, and this
 * test needs no edit to keep holding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PROFILES = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const HANDLER = join(SCRIPTS, 'lib/agent-ladder.sh');

/** Seams whose archetype declares a ladder — the set that must escalate. */
function laddered(): string[] {
  const p = JSON.parse(readFileSync(PROFILES, 'utf8')).profiles || {};
  return Object.entries(p).filter(([, v]: any) => v && v.ladder).map(([k]) => k);
}

/** Every model name the PROJECTS declare, from their own ladder definitions. */
function declaredModels(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/llm-settings\.json$/.test(e.name)) continue;
      try {
        const doc = JSON.parse(readFileSync(p, 'utf8'));
        for (const tier of Object.values(doc.ladders || {}) as any[]) {
          for (const rung of tier?.modelLadder || []) {
            if (rung?.from) names.add(String(rung.from));
            if (rung?.to) names.add(String(rung.to));
          }
        }
      } catch { /* a project without settings contributes nothing */ }
    }
  };
  if (existsSync(PROJECTS)) walk(PROJECTS);
  return [...names];
}

/**
 * script -> the seams it announces itself as, read from the code's own declaration.
 *
 * A script may pass the name literally, `seam_ladder_export "repro-test-writer"`, or through the
 * single declaration it keeps for it, `seam_ladder_export "$_SEAM_NAME"`. Both are the same
 * statement; only the second is refactor-safe, and it is the shape this suite pushed every script
 * towards. Resolving it matters: when these scripts moved to the variable form, a discovery that
 * only understood literals stopped seeing five of six consumers and the suite went green by
 * finding nothing to check.
 */
function consumers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'))) {
    const s = readFileSync(join(SCRIPTS, f), 'utf8');
    const seams: string[] = [];
    for (const m of s.matchAll(/seam_ladder_export\s+["']?\$?\{?([A-Za-z0-9_.:-]+)\}?["']?/g)) {
      const token = m[1];
      if (/^[A-Z_][A-Z0-9_]*$/.test(token)) {
        // A shell variable: resolve it to the literal the script assigns it.
        const assign = s.match(new RegExp(`${token}=["']([^"'\\n]+)["']`));
        if (assign) seams.push(assign[1]);
      } else {
        seams.push(token);
      }
    }
    if (seams.length) out.set(f, [...new Set(seams)]);
  }
  return out;
}

/** Literal model names used as a shell fallback default, e.g. `${VAR:-<model>}`. */
function modelLiterals(text: string, models: string[]): string[] {
  const hits = new Set<string>();
  for (const m of models) {
    const esc = m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    if (new RegExp(`:-\\s*${esc}\\b`).test(text)) hits.add(m);
  }
  return [...hits];
}

const MODELS = declaredModels();
const CONSUMERS = consumers();

describe('THE INPUTS ARE DISCOVERED, NOT ASSUMED', () => {
  it('the projects declare a model vocabulary', () => {
    // Without this every literal check below passes vacuously.
    expect(MODELS.length, 'no models discovered from any project llm-settings.json').toBeGreaterThan(0);
  });

  it('at least one seam declares a ladder', () => {
    expect(laddered().length, 'no seam declares a ladder').toBeGreaterThan(0);
  });

  it('scripts announce which seam they are', () => {
    expect(CONSUMERS.size, 'no script calls seam_ladder_export — the mapping cannot be derived')
      .toBeGreaterThan(0);
  });
});

describe('THE HANDLER IS GENERIC', () => {
  it('exists', () => {
    expect(existsSync(HANDLER), 'the shared ladder handler is gone').toBe(true);
  });

  it('names no model the projects declare', () => {
    const hits = modelLiterals(readFileSync(HANDLER, 'utf8'), MODELS);
    expect(hits, `the handler carries model literals: ${hits.join(', ')}`).toHaveLength(0);
  });
});

describe('EVERY CONSUMER REACHES THE SHARED HANDLER', () => {
  // A consumer satisfies this two ways, and both are legitimate:
  //   DIRECTLY   it calls agent_ladder_* itself.
  //   DELEGATED  it invokes the shared runner, which calls agent_ladder_* on its behalf — but
  //              only if it also DECLARES WHICH AGENT IT IS. The runner resolves the chain from
  //              the archetype and keys rung state per agent, so an invocation with no identity
  //              gets neither: it silently climbs whatever default is lying around. That is
  //              exactly what happened while nothing set EPAM_AGENT_NAME and every agent shared
  //              one counter under "agent__<story>".
  const ladderSeams = new Set(laddered());
  for (const [script, seams] of CONSUMERS) {
    const declaring = seams.filter((s) => ladderSeams.has(s));
    if (!declaring.length) continue;
    it(`${script} (${declaring.join(', ')}) reaches the shared handler`, () => {
      const s = readFileSync(join(SCRIPTS, script), 'utf8');
      const direct = /agent_ladder_(model|record_failure|exhausted)/.test(s);
      const delegates = /ai-run\.sh|AI_RUNNER_CMD/.test(s);
      const declaresIdentity = /export\s+EPAM_AGENT_NAME=/.test(s);
      expect(direct || (delegates && declaresIdentity),
        `${script} announces seam(s) ${declaring.join(', ')} which declare a ladder, but it ` +
        `neither calls the shared handler nor delegates to the runner with an identity ` +
        `(direct=${direct} delegates=${delegates} declaresIdentity=${declaresIdentity})`)
        .toBe(true);
    });
  }
});

describe('NO CONSUMER KEEPS A PRIVATE CHAIN', () => {
  // Reaching the handler is not enough if the script ALSO carries its own chain and uses that
  // instead. team-lead-review.sh is the live instance: it declares HIGHEST and walks a private
  // map pinned to EPAM_MODEL_LADDER_HIGH, so its declaration selects nothing.
  const ladderSeams = new Set(laddered());
  for (const [script, seams] of CONSUMERS) {
    const declaring = seams.filter((s) => ladderSeams.has(s));
    if (!declaring.length) continue;
    it(`${script} does not walk a model chain of its own`, () => {
      const s = readFileSync(join(SCRIPTS, script), 'utf8');
      const privateChain = [...s.matchAll(/EPAM_MODEL_LADDER_[A-Z]+/g)].map((m) => m[0]);
      expect([...new Set(privateChain)],
        `${script} reads ${[...new Set(privateChain)].join(', ')} directly, pinning it to one ` +
        `tier regardless of what its archetype declares — the handler resolves the tier, so a ` +
        `consumer never needs to name a chain`)
        .toHaveLength(0);
    });
  }
});

describe('NO CONSUMER OVERRIDES ITS DECLARED LADDER WITH A LITERAL', () => {
  const ladderSeams = new Set(laddered());
  for (const [script, seams] of CONSUMERS) {
    const declaring = seams.filter((s) => ladderSeams.has(s));
    if (!declaring.length) continue;
    it(`${script} names no declared model as a fallback`, () => {
      const hits = modelLiterals(readFileSync(join(SCRIPTS, script), 'utf8'), MODELS);
      expect(hits,
        `${script} hardcodes ${hits.join(', ')} as a fallback — a literal silently overrides the ` +
        `tier its archetype declares, and no configuration can remove it`)
        .toHaveLength(0);
    });
  }
});
