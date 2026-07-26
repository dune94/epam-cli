/**
 * Every agent says who it is.
 *
 * Agent identity reaches ai-run.sh through EPAM_AGENT_NAME, and it is what
 * names the plan record, the Langfuse trace, and the cost attribution. Tonight
 * it was set in exactly one place — the detective — so every other agent's plan
 * was written as `agent:plan`, attributable to nothing.
 *
 * That was fixed twice and missed twice. First at ai-run.sh, which is universal
 * for INVOCATION but has no idea who is calling it. Then in runClaude, which
 * covers spec-mode-runner's agents but not the four lib/*.js agents that call
 * ai-run.sh through execSync directly. Each fix looked like a seam fix and was
 * really a partial one.
 *
 * So the guard is a registry, not another seam: enumerate every script that
 * invokes ai-run.sh and require each to name its agent. A new agent that forgets
 * fails here rather than appearing months later as an anonymous row in a cost
 * table nobody can reconcile.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/** Scripts that invoke ai-run.sh and therefore produce an agent call. */
function callSites(): string[] {
  const found: string[] = [];
  const scan = (dir: string, prefix = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name === 'lib') scan(join(dir, e.name), 'lib/');
      else if (e.isFile() && /\.(sh|js)$/.test(e.name)) {
        const rel = prefix + e.name;
        if (rel.endsWith('ai-run.sh')) continue;      // the seam itself
        const src = readFileSync(join(dir, e.name), 'utf8');
        if (/ai-run\.sh|AI_RUNNER_CMD/.test(src)) found.push(rel);
      }
    }
  };
  scan(SCRIPTS);
  return found.sort();
}

/**
 * Scripts that MENTION the runner without invoking it. Listed explicitly, with
 * the reason, so "it doesn't really call it" is a claim on the record rather
 * than a regex that quietly stops matching.
 */
const NOT_INVOKERS: Record<string, string> = {
  'kill-tier3-run.sh': 'sweeps ai-run.sh processes by name when killing a run',
  'lib/cost-emitter.js': 'reads cost records after the fact; makes no model call',
  'lib/agent-invoke.sh': 'the gateway itself — it sets the name for its callers',
};

const KNOWN_UNNAMED: string[] = [
  'agent-attempt-analyst.sh',
  'brownfield-repro-test-writer.sh',
  'claude.sh',
  'code-review-cycle.sh',
  'contextualize-stories.sh',
  'lib/ac-gate.js',
  'lib/codeline-discovery.js',
  'lib/constraint-compiler.js',
  'lib/cpa-inference.js',
  'lib/kb-cli.js',
  'lib/kb-synthesizer.js',
  'lib/story-guards.sh',
  'orchestrate.sh',
  'team-lead-review.sh',
  'test-engine.sh',
  'tier3-metrolinx-run.sh',
  'tier3-skyscanner-app-run.sh',
  'tier3-travel-app-run.sh',
  'update-invalidated-tests.sh',
];

describe('every ai-run.sh call site names its agent', () => {
  const sites = callSites().filter(s => !(s in NOT_INVOKERS));

  it('finds the call sites at all (guards the guard)', () => {
    expect(sites.length).toBeGreaterThan(4);
  });

  it('the seam names an unnamed caller rather than recording "agent"', () => {
    // The backstop that makes the list below survivable: until every site names
    // itself, ai-run.sh derives a name from the invoking script.
    const src = readFileSync(join(SCRIPTS, 'ai-run.sh'), 'utf8');
    expect(src).toMatch(/\/proc\/\$?\{?PPID/);
  });

  it('the set of unnamed call sites does not grow', () => {
    // A baseline, not an approval. These invoke agents without declaring who
    // they are; the seam derives a name from the script, which is imperfect —
    // one script can host several agents, and they all collapse to one label.
    // Fix them by setting EPAM_AGENT_NAME and deleting the entry. Nothing may
    // be ADDED: a new anonymous agent fails here rather than surfacing later as
    // a cost row nobody can reconcile.
    const unnamed = sites.filter(
      s => !/EPAM_AGENT_NAME/.test(readFileSync(join(SCRIPTS, s), 'utf8')));
    const added = unnamed.filter(s => !KNOWN_UNNAMED.includes(s));
    expect(added, `new anonymous agent call site(s): ${added.join(', ')}`).toEqual([]);
  });

  it('the baseline has no stale entries', () => {
    // Keeps the list honest as sites get fixed.
    const stillUnnamed = KNOWN_UNNAMED.filter(s => {
      try { return !/EPAM_AGENT_NAME/.test(readFileSync(join(SCRIPTS, s), 'utf8')); }
      catch { return false; }
    });
    expect(KNOWN_UNNAMED.filter(s => !stillUnnamed.includes(s)),
      'these are named now — remove them from KNOWN_UNNAMED').toEqual([]);
  });

  for (const site of KNOWN_UNNAMED.length ? [] : sites) {
    it(`${site}`, () => {
      const src = readFileSync(join(SCRIPTS, site), 'utf8');
      // Either it sets the name directly, or it derives one from the cost label
      // it already declares — both make the agent identifiable downstream.
      const names = /EPAM_AGENT_NAME/.test(src);
      expect(names,
        `${site} invokes an agent without setting EPAM_AGENT_NAME, so its plan ` +
        'record, Langfuse trace and cost row are all anonymous')
        .toBe(true);
    });
  }
});
