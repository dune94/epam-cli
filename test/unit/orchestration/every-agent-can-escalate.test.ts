/**
 * AN AGENT THAT CANNOT ESCALATE RETRIES ITSELF UNTIL ITS BUDGET IS GONE.
 *
 * Live 2026-08-11, AMSD-2041/gotransit, both halves visible in one run:
 *
 *   The WRITER hit an unused-variable error it could not shake. Two attempts on MiniMax-M3
 *   changed nothing (the second produced 682 output tokens — a couple of sentences). HealingBroken
 *   fired, escalated to z-ai/glm-5.2, and the next rung cleared it in 25 seconds.
 *
 *   The REPRO-TEST-WRITER hit two ordinary lint violations and had no ladder. The pipeline said so
 *   itself — "WARNING: NO ladder escalation on attempt 2/3 — ladder is EMPTY/unset — NO escalation
 *   configured for this run" — and then retried on the same model anyway, three times, and lost
 *   the work.
 *
 * Same class of problem, opposite outcomes, decided entirely by whether a `ladder` key existed.
 *
 * 11 of 17 profiles had none. The 6 that did were all HIGHEST, which is the tell: nobody chose a
 * tier per seam — HIGHEST was added to whichever seams were under discussion at the time, and the
 * rest were never revisited. Both failure analysts were in the missing set, so when an agent
 * failed, the thing diagnosing it could not buy a better opinion either.
 *
 * DYNAMIC AGENTS ARE COVERED BY THE SAME KEY. A minted agent (a per-codeline investigator, an
 * implementer role invented for this project) is not a profile of its own — it is invoked AT a
 * seam, and lib/seam-invocation.js resolves the ladder from that seam's entry. So a project's
 * generated agents inherit escalation automatically, provided the seam they run at declares one.
 * That is why this file asserts on seams and not on agent names.
 *
 * Written BEFORE the assignment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

function profiles(): Record<string, any> {
  const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(parsed.profiles || parsed)) {
    if (k.startsWith('_') || k === 'defaults') continue;
    if (v && typeof v === 'object') out[k] = v;
  }
  return out;
}

/** The ladders the project declares, from its own llm-settings. */
function declaredLadders(): string[] {
  const s = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
  return Object.keys(s.ladders || {}).map((l) => l.toLowerCase());
}

describe('the registry is readable and non-trivial', () => {
  it('there are profiles to check — otherwise every assertion below passes vacuously', () => {
    expect(Object.keys(profiles()).length).toBeGreaterThan(10);
  });
});

describe('EVERY SEAM CAN ESCALATE', () => {
  it('no profile is missing a ladder', () => {
    const without = Object.entries(profiles())
      .filter(([, v]) => !v.ladder || String(v.ladder).trim() === '')
      .map(([k]) => k);
    expect(
      without,
      'a seam with no ladder retries on one model until its budget is gone. repro-test-writer ' +
      'burned all 3 attempts that way while the writer, hitting the same class of problem, was ' +
      'rescued by escalation 20 minutes earlier in the same run',
    ).toEqual([]);
  });

  it('every declared ladder resolves to one the project actually defines', () => {
    const known = declaredLadders();
    expect(known.length, 'no ladders declared — this check would pass vacuously').toBeGreaterThan(0);
    const unresolvable = Object.entries(profiles())
      .filter(([, v]) => v.ladder && !known.includes(String(v.ladder).toLowerCase()))
      .map(([k, v]) => `${k} -> ${v.ladder}`);
    expect(
      unresolvable,
      'seam-invocation.js warns and falls back to the run default when the ladder name has no ' +
      'EPAM_MODEL_LADDER_<NAME> — a ladder that does not resolve is the same as no ladder, ' +
      'except it looks configured',
    ).toEqual([]);
  });
});

describe('THE TIER IS A CHOICE, NOT A DEFAULT', () => {
  /**
   * Before this, all six ladders present were HIGHEST — not because six seams needed the top
   * tier, but because HIGHEST was what got added to whichever seam was being discussed. If every
   * seam ends up HIGHEST again the key stops carrying information and the cost is real: HIGHEST
   * starts on a stronger model for every call, not only on retry.
   */
  it('more than one tier is in use', () => {
    const tiers = new Set(Object.values(profiles()).map((v) => String(v.ladder || '').toLowerCase()));
    expect(
      tiers.size,
      'every seam on one tier means the tier was never chosen — HIGHEST also starts on a ' +
      'stronger model for every call, not just on escalation',
    ).toBeGreaterThan(1);
  });

  it('seams whose failure is SILENT climb the top tier', () => {
    // A wrong review, a wrong gate verdict or a wrong classification looks exactly like a right
    // one downstream. Those are the seams worth paying for.
    const p = profiles();
    for (const seam of ['team-lead-review', 'roster-review', 'code-review-cycle', 'cpa-gate', 'prd-change-reviewer']) {
      if (!p[seam]) continue;
      expect(String(p[seam].ladder).toLowerCase(), `${seam} judges other work; a wrong verdict is invisible`).toBe('highest');
    }
  });
});

describe('BOTH CONSUMERS READ THE KEY — a ladder nothing reads is decoration', () => {
  it('the JS seam resolver reads profile.ladder', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'), 'utf8');
    expect(src).toContain('profile.ladder');
    expect(src, 'the name must map to the project-declared rungs').toContain('EPAM_MODEL_LADDER_');
  });

  it('the shell invoke gateway reads it too', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/agent-invoke.sh'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code, 'shell-invoked seams would silently have no ladder').toMatch(/agent_profile_get\s+"\$role"\s+ladder/);
  });
});

describe('A DYNAMIC AGENT INHERITS ITS SEAM\'S LADDER', () => {
  it('resolution is by seam, so a minted agent needs no profile of its own', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { seamInvocationEnv } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    process.env.AGENT_PROFILES_REGISTRY = REGISTRY;
    process.env.EPAM_MODEL_LADDER_HIGHEST = 'model-a=model-b';
    const env = seamInvocationEnv('code-graph-detective', '');
    expect(
      env.EPAM_MODEL_LADDER,
      'the per-codeline investigator minted for this project runs at this seam and inherits this',
    ).toBe('model-a=model-b');
    expect(env.EPAM_MODEL, 'and starts on the first rung, not the run default').toBe('model-a');
  });
});

/**
 * RESOLVES AT RUNTIME, not just in the registry.
 *
 * The check above only proves the ladder NAME appears in llm-settings.json. seam-invocation.js
 * resolves `EPAM_MODEL_LADDER_<NAME>` from the ENVIRONMENT, and if that variable is unset it
 * warns and falls back to the run default — so a name that is declared but never exported is
 * indistinguishable from no ladder at all, except that it looks configured. claude.sh's
 * load_llm_settings_json is what populates them; this executes that path.
 */
describe('EVERY TIER IN USE IS ACTUALLY EXPORTED BY THE LOADER', () => {
  const { execFileSync } = require('node:child_process');

  function loadedLadderVars(): Record<string, string> {
    const claude = join(ROOT, 'orchestrations/scripts/claude.sh');
    const src = readFileSync(claude, 'utf8');
    const start = src.indexOf('load_llm_settings_json() {');
    expect(start, 'load_llm_settings_json moved — this test is anchored on it').toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n}\n', start) + 2);

    const out = execFileSync('bash', ['-c',
      `set -u
       # The loader falls back to AUTOMATION_DIR when no project config dir is set, so both must
       # be defined for set -u to survive. Supplying them is what the real script does.
       AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}
       # SCRIPT_DIR too: the loader now reads the ladders through lib/model-ladders.sh, shared
       # with every other entry point rather than hand-written inside claude.sh. Lifting the
       # function out of the script means BASH_SOURCE points at the temp file, so the script
       # directory has to be supplied — as the real script does.
       SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
       EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(join(ROOT, 'orchestrations/projects/metrolinx'))}
       ${body}
       load_llm_settings_json >/dev/null 2>&1 || true
       for v in EPAM_MODEL_LADDER_HIGH EPAM_MODEL_LADDER_MEDIUM EPAM_MODEL_LADDER_HIGHEST; do
         echo "$v=\${!v:-}"
       done`,
    ], { encoding: 'utf8' });

    const vars: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) vars[line.slice(0, i)] = line.slice(i + 1);
    }
    return vars;
  }

  it('every tier a seam asks for is populated with real rungs', () => {
    const vars = loadedLadderVars();
    const used = new Set(Object.values(profiles()).map((v) => String(v.ladder || '').toUpperCase()));
    expect(used.size, 'no tiers in use — vacuous').toBeGreaterThan(0);
    for (const tier of used) {
      const key = `EPAM_MODEL_LADDER_${tier}`;
      expect(
        vars[key],
        `${key} is empty, so every seam on the '${tier}' tier silently falls back to the run ` +
        'default. seam-invocation.js warns about this and continues — a ladder that does not ' +
        'resolve looks configured and escalates nothing.',
      ).toBeTruthy();
      expect(vars[key], `${key} must contain from=to rungs`).toContain('=');
    }
  });
});
