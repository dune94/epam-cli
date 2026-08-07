/**
 * B28 — PIPELINE-WIDE INVARIANT: every agent invocation must set an output budget.
 *
 * Metrolinx routes reasoning models everywhere (z-ai/glm-5.2, z-ai/glm-5.1). Their
 * <think> blocks count against EPAM_MAX_OUTPUT_TOKENS. Any site that does not set it
 * inherits AgentRunner's 4096 default — sized for a non-reasoning
 * single-file edit — and the model exhausts the budget THINKING, emitting truncated
 * intermediate text before it ever writes its answer. ai-run.sh then returns that
 * fragment as "the result".
 *
 * Live (metrolinx 2026-07-25): team-lead-review.sh sets EPAM_REASONING_EFFORT=high
 * and NO output floor. The reviewer emitted 169 bytes — "Now let me verify the test
 * actually covers the prescribed fix scenario..." — mid-sentence, no verdict. The
 * pipeline reported "review output unparseable" and blocked. It was NOT a model
 * problem: a non-reasoning model (claude-haiku) fits under 4096 and passed, which is
 * exactly how a standalone test masked it.
 *
 * THIS BUG WAS DIAGNOSED AND FIXED TWICE BEFORE — for the code-graph-detective
 * ("SPEC_MODE_MAX_OUTPUT_TOKENS (6000) ... far too small here — the model exhausts
 * it mid-reasoning and emits an EMPTY result BEFORE writing the JSON") and for the
 * impl agent. Both were patched INDIVIDUALLY as they failed. Five sites that had not
 * failed yet kept the defect.
 *
 * That is the real lesson, and why this file is a REGISTRY test rather than another
 * per-bug test: a test written per incident only ever covers the site that already
 * broke. This one fails for ANY invocation site missing a required parameter,
 * including sites added in future.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts/');
const root = (p: string) => join(SCRIPTS, p);
const read = (p: string) => (existsSync(root(p)) ? readFileSync(root(p), 'utf8') : '');

/** Below this, a glm-5.x/kimi response can be consumed entirely by <think>. */
const REASONING_FLOOR = 16384;

/**
 * Every script that invokes an agent. This list is not the safety mechanism — the
 * ai-run.sh net is. It exists so that ADDING an invocation site forces a human to
 * look at this file (the staleness test below fails otherwise).
 */
const AGENT_SITES = [
  'team-lead-review.sh',
  'code-review-cycle.sh',
  'agent-attempt-analyst.sh',
  'brownfield-repro-test-writer.sh',
  'contextualize-stories.sh',
  'claude.sh',
  'spec-mode-runner.js',
  'mint-agents-step.js',
  'lib/cpa-inference.js',
  'lib/ac-gate.js',
  'lib/codeline-discovery.js',
  // Self-heal synthesis: bounded by the generated JSON Schema. Sets an EXPLICIT
  // budget rather than relying on the ai-run.sh net — a reasoning model spends
  // <think> tokens against the same allowance, and a truncated reply never
  // reaches the closing brace, so it is quarantined as 'unparseable'.
  'lib/kb-synthesizer.js',
  // The shell-facing seam (record/synthesize-auto/apply/tick). Its only model
  // call is delegated to kb-synthesizer.js above.
  'lib/kb-cli.js',
  // Verification, not generation: one closed yes/no question per criterion about
  // two artefacts that already exist. It sets no reasoning effort and needs no
  // explicit budget — the reply is a single small JSON object, and an unparseable
  // one is reported as UNKNOWN rather than counted as a gap.
  'vc-coverage-check.sh',
];

describe('B28 — the central net (the actual fix)', () => {
  it('ai-run.sh defaults EPAM_MAX_OUTPUT_TOKENS when the caller set none', () => {
    const src = read('ai-run.sh');
    const m = src.match(/EPAM_MAX_OUTPUT_TOKENS="\$\{EPAM_MAX_OUTPUT_TOKENS:-(\d+)\}"/);
    expect(m, 'ai-run.sh must floor the budget so an unset site cannot fall to AgentRunner\'s 4096').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(REASONING_FLOOR);
  });

  it('applies the default without clobbering an explicit per-site value', () => {
    const src = read('ai-run.sh');
    // `${VAR:-default}` only substitutes when unset/empty — an explicit value wins.
    expect(src).toMatch(/EPAM_MAX_OUTPUT_TOKENS="\$\{EPAM_MAX_OUTPUT_TOKENS:-/);
  });
});

describe('B28 — no site pairs high reasoning effort with a starved budget', () => {
  // This is the exact live shape: EPAM_REASONING_EFFORT=high and no/low budget, so
  // the model spends the whole allowance thinking and emits a truncated fragment.
  for (const site of AGENT_SITES.filter(s => s.endsWith('.sh') && s !== 'claude.sh')) {
    it(`${site}`, () => {
      const src = read(site);
      if (!/EPAM_REASONING_EFFORT[^\n]*high/.test(src)) return;
      const m = src.match(/EPAM_MAX_OUTPUT_TOKENS="?\$\{[A-Za-z_]+:-(\d+)\}/);
      expect(m, `${site} sets high effort but no explicit output budget`).toBeTruthy();
      expect(Number(m![1]), `${site} budget is below the reasoning floor`).toBeGreaterThanOrEqual(REASONING_FLOOR);
    });
  }
});

describe('B28 — claude.sh brownfield floor', () => {
  // claude.sh is 7k lines and sets STORY_MAX_OUTPUT_TOKENS in ~10 places (per-tier
  // defaults, ladder-rung raises, and this floor). It is NOT sourceable standalone,
  // so the one durable thing to pin is the floor every brownfield story passes
  // through — resolve_effort_settings raises any lower tier value up to it.
  it('raises reasoning-model stories to a budget that fits think + write', () => {
    const m = read('claude.sh').match(/_bf_min_out="\$\{EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS:-(\d+)\}"/);
    expect(m, 'claude.sh lost its brownfield output-token floor').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(REASONING_FLOOR);
  });
});

/**
 * Not invocation sites: the runner itself; orchestrators/wrappers that only pass
 * AI_RUNNER_CMD through to a child; helpers that merely name the variable.
 * Verified per file — each either has no spawn call or delegates to a listed site.
 */
const EXEMPT = /^(lib\/agent-invoke\.sh|ai-run\.sh|run-agent-orchestration\.sh|orchestrate\.sh|test-engine\.sh|kill-tier3-run\.sh|post-impl-tc-writer\.sh|update-invalidated-tests\.sh|lib\/tc-writer-gate\.sh|lib\/story-guards\.sh|lib\/cost-emitter\.js|tier[0-9].*\.sh|test\/.*)$/;

describe('B28 — the registry cannot silently go stale', () => {
  it('no agent-invoking script is missing from AGENT_SITES', () => {
    // Scan CODE, not comments. A doc-comment that merely mentions ai-run.sh is not
    // an invocation site; grepping raw text reported constraint-compiler.js purely
    // because a comment named the runner, and that false positive would recur on
    // every explanatory comment anyone writes.
    const found = execFileSync('bash', ['-c',
      `grep -rlE 'AI_RUNNER_CMD|run_orch_prompt|ai-run\\.sh' ${JSON.stringify(SCRIPTS)} --include='*.sh' --include='*.js' || true`,
      ], { encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter(abs => {
        const code = readFileSync(abs, 'utf8').split('\n')
          .filter(l => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join('\n');
        return /AI_RUNNER_CMD|run_orch_prompt|ai-run\.sh/.test(code);
      })
      .map(p => p.replace(SCRIPTS, ''))
      // not invocation sites: the runner itself, orchestrators that delegate, wrappers
      .filter(p => !EXEMPT.test(p));
    const missing = found.filter(f => !AGENT_SITES.includes(f));
    expect(missing, 'new agent invocation site(s) — register in AGENT_SITES and confirm the budget').toEqual([]);
  });
});

describe('B28 — dead parameter names', () => {
  it('no script sets EPAM_MAX_TOKENS (nothing reads it — EPAM_MAX_OUTPUT_TOKENS is the real one)', () => {
    // post-impl-tc-writer.sh set EPAM_MAX_TOKENS=8192 and silently ran at 4096.
    const hits = execFileSync('bash', ['-c',
      `grep -rn 'EPAM_MAX_TOKENS' ${JSON.stringify(SCRIPTS)} --include='*.sh' --include='*.js' || true`],
      { encoding: 'utf8' }).trim();
    expect(hits, 'EPAM_MAX_TOKENS is read by no code path').toBe('');
  });
});
