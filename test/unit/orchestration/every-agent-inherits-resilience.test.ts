/**
 * EVERY agent — core or newly added — inherits retry, ladder and self-heal.
 *
 * This is a registry test. Its job is not to check today's agents but to FAIL
 * the moment someone adds an agent, or a call site, that does not inherit.
 *
 * Why it exists: on 2026-07-28 an audit of 20 model call sites found
 *
 *   retry      hand-rolled per site         6 sites
 *   ladder     _ladder_next_model() copied into 3 files
 *   self-heal  lib/kb-apply.sh called from claude.sh ONLY
 *
 * The unprotected ones were not obscure. They included codeline-discovery
 * (chooses which repositories the run modifies) and ac-gate (writes the
 * acceptance criteria everything downstream is judged against). Both single
 * shot. One empty response on discovery silently turned a three-codeline ticket
 * into a one-lane run that would have reported success.
 *
 * Every one of those gaps was created the same way: a new call site was added
 * and the author did not know — or forgot — to wire in three separate
 * mechanisms. Per-site patches would leave the same trap set for the next
 * author.
 *
 * So the guarantee lives at ai-run.sh, the single seam every model call passes
 * through, keyed on EPAM_AGENT_NAME — which is always set, explicitly by the
 * caller or derived from /proc/$PPID/cmdline. A new agent in profiles.json
 * inherits all three by construction, including its own KB, because the seam
 * applies constraints and records episodes under that agent's name.
 *
 * These tests guard the inheritance, not the list.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const SEAM = readFileSync(join(SCRIPTS, 'ai-run.sh'), 'utf8');
const PROFILES: Record<string, unknown> = JSON.parse(
  readFileSync(join(__dirname, '../../../orchestrations/agents/profiles.json'), 'utf8'));

/** Every script/module in the orchestration tree. */
function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (/\.(sh|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(SCRIPTS);
  return out;
}

/** Files that invoke a model. */
function callSites(): Array<{ path: string; src: string }> {
  return allSources()
    .filter((p) => !/\/ai-run\.sh$/.test(p) && !/\/test\//.test(p))
    .map((p) => ({ path: p, src: readFileSync(p, 'utf8') }))
    .filter(({ src }) => /ai-run\.sh|AI_RUNNER_CMD|EPAM_CLI["'\s]/.test(src));
}

describe('the seam provides all three guarantees', () => {
  it('retries', () => {
    expect(SEAM, 'the seam does not retry — every call site is one bad response from failing')
      .toMatch(/EPAM_CALL_MAX_ATTEMPTS/);
  });

  it('escalates the model between attempts', () => {
    expect(SEAM, 'retries repeat the same gamble on the same model')
      .toMatch(/_ai_ladder_next_model/);
  });

  it('applies and records self-heal per agent', () => {
    expect(SEAM, 'self-heal is not applied at the seam').toMatch(/_ai_kb_before/);
    expect(SEAM, 'failures teach the agent nothing').toMatch(/_ai_kb_after_failure/);
  });

  it('keys self-heal on the AGENT, so each accumulates its own KB', () => {
    // A new agent in profiles.json gets its own KB with no wiring: the seam
    // already knows who called it.
    const i = SEAM.indexOf('_ai_kb_before()');
    expect(SEAM.slice(i, i + 400), 'the KB is not per-agent — all agents share one')
      .toMatch(/EPAM_AGENT_NAME/);
  });
});

describe('no call site can bypass the seam', () => {
  it('every model call goes through ai-run.sh', () => {
    // The inheritance only holds if nothing calls a provider directly.
    const bypass = callSites()
      .filter(({ src }) => !/ai-run\.sh|AI_RUNNER_CMD/.test(src))
      .map(({ path }) => path.replace(SCRIPTS, ''));
    expect(bypass,
      `these invoke a model without going through the seam, so they inherit ` +
      `nothing:\n  ${bypass.join('\n  ')}`)
      .toEqual([]);
  });

  it('the seam is reachable from every call site\'s path', () => {
    for (const { path, src } of callSites()) {
      if (!/ai-run\.sh/.test(src)) continue;
      const m = src.match(/["'`]?([^"'`\s]*ai-run\.sh)/);
      expect(m, `${path} references ai-run.sh in an unresolvable form`).toBeTruthy();
    }
  });
});

describe('a new agent inherits without being wired', () => {
  it('profiles.json roles need no per-agent resilience configuration', () => {
    // Nothing in a profile declares retry/ladder/self-heal — if it did, adding
    // an agent would mean remembering to set it, which is exactly how the 14
    // unprotected sites happened.
    const withWiring = Object.entries(PROFILES)
      .filter(([, v]) => /MAX_ATTEMPTS|_ladder_next_model|kb_apply_constraints/.test(String(v)))
      .map(([k]) => k);
    expect(withWiring,
      `these profiles hand-configure resilience instead of inheriting it: ${withWiring.join(', ')}`)
      .toEqual([]);
  });

  it('the self-heal library is not confined to one caller', () => {
    // It was called from claude.sh alone, so only story agents ever healed.
    const users = allSources()
      .filter((p) => !/kb-apply\.sh/.test(p))
      .filter((p) => /kb_apply_constraints|kb-apply\.sh/.test(readFileSync(p, 'utf8')));
    expect(users.length,
      'self-heal reaches only one caller — a new agent would not inherit it')
      .toBeGreaterThan(1);
  });

  it('the KB library exists where the seam expects it', () => {
    expect(existsSync(join(SCRIPTS, 'lib/kb-apply.sh')),
      'the seam sources a self-heal library that is not there').toBe(true);
  });
});

describe('resilience never converts a failure into a silent success', () => {
  it('still exits non-zero when every attempt fails', () => {
    const i = SEAM.lastIndexOf('exit 1');
    expect(i, 'the seam no longer fails at all').toBeGreaterThan(-1);
  });

  it('reports how many attempts were spent', () => {
    expect(SEAM, 'an exhausted call is indistinguishable from a single failure')
      .toMatch(/attempt\(s\)|attempts/);
  });

  it('does not multiply the budget through the plan pass', () => {
    // ai-run.sh re-invokes itself; without the guard, attempts would square.
    const i = SEAM.indexOf('_ai_max_attempts');
    expect(SEAM.slice(i, i + 400), 'the plan pass would multiply the retry budget')
      .toMatch(/_EPAM_IN_PLAN_PASS/);
  });
});
