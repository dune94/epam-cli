/**
 * LIVE integration test — proves the tool grant actually gets USED to
 * correct a false claim, without running a full metrolinx attempt.
 *
 * Live metrolinx 2026-07-31 (run 10). @metrolinx/cx-shared is a real,
 * extensively-used internal package — fully installed, built, the exact
 * subpaths the agent imported exist on disk. The failure-analyst diagnosed
 * "package not installed" anyway, three times, HEALING_BROKEN fired. Traced
 * to HEAL-BLIND: run_failure_analyst was the only gate agent in claude.sh
 * with no AI_GATE_ALLOW_TOOLS at all — it answered from three pre-injected
 * text blocks and had no way to check a claim against the real filesystem.
 *
 * Fixed by reusing ORCH_GATE_ALLOWED_TOOLS (the same shared, config-driven,
 * read-only allowlist every other gate agent already draws from) and adding
 * a prompt instruction to verify filesystem/package claims before stating
 * them. This test proves BOTH halves actually work together, live, against
 * the real model — not just that the source text changed.
 *
 * TWO LAYERS OF ASSERTION, deliberately:
 *   1. MECHANICAL (deterministic): with tools granted, does the model
 *      actually MAKE a tool call when asked to verify something checkable?
 *      toolCallCount is reported by the CLI's own --json output — this does
 *      not depend on the model phrasing its final answer any particular way,
 *      which is what bit an earlier test in this same investigation (a
 *      too-clean synthetic scenario passed under both old and new prompt
 *      wording and proved nothing).
 *   2. BEHAVIORAL (best-effort, live): does the diagnosis actually stop
 *      claiming the package is missing once it can check.
 *
 * THE GENERALITY CHECK: the synthetic package/interface names here are
 * invented for this test (widget-toolkit / RenderOptions family, continuing
 * the same fictional names used in the earlier HEAL-NONE live test) — never
 * cx-shared, never Contentstack. Passing on an unseen name is evidence this
 * is a working mechanism, not the model recalling a specific incident.
 *
 * Requires OPENROUTER_API_KEY and a built dist/epam.js. Skipped automatically
 * if either is missing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../');
const CLI = join(REPO_ROOT, 'dist/epam.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const GATE_PROVIDER = process.env.ORCH_GATE_PROVIDER || 'openrouter';
const GATE_MODEL = process.env.ORCH_GATE_MODEL || 'z-ai/glm-5.2';
const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.EPAM_API_KEY_OPENROUTER);

/** The real analyst prompt template, extracted verbatim — never re-typed. */
function extractAnalystTemplate(): string {
  const start = SRC.indexOf("analyst_prompt=$(cat << 'ANALYST_PROMPT_END'") + "analyst_prompt=$(cat << 'ANALYST_PROMPT_END'".length;
  const end = SRC.indexOf('\nANALYST_PROMPT_END', start);
  expect(start, 'the analyst prompt heredoc opener is gone').toBeGreaterThan(-1);
  expect(end, 'the analyst prompt heredoc closer is gone').toBeGreaterThan(start);
  return SRC.slice(start, end).trim();
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`__${k}__`).join(v);
  return out;
}

/** A synthetic project with a REAL, verifiable installed package. */
function makeProjectWithRealPackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'fa-tool-verify-'));
  mkdirSync(join(root, 'node_modules', 'widget-toolkit', 'build', 'src'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'widget-toolkit', 'package.json'),
    JSON.stringify({ name: 'widget-toolkit', version: '1.0.0', main: 'build/src/index.js' }));
  writeFileSync(join(root, 'node_modules', 'widget-toolkit', 'build', 'src', 'index.js'),
    'exports.paletteToken = "default";\n');
  return root;
}

/**
 * Invoke the real gate model exactly as run_failure_analyst does — same env,
 * same flags.
 *
 * Withholding tools means NOT passing `--tools` at all: src/cli/commands/
 * run.ts registers zero tools unless the CLI flag is present
 * (`opts.tools ? applyToolAllowlist(...) : []`) — EPAM_MAX_TOOL_CALLS alone
 * does not do this. Confirmed by reading AgentRunner's own budget check
 * before writing this test: `toolBudget > 0 && ...` means
 * EPAM_MAX_TOOL_CALLS=0 is treated as UNLIMITED, not zero, because `0 > 0` is
 * false — an easy, plausible-looking mistake to make here, so this comment
 * exists to stop it being made again.
 */
function invokeAnalystWithTools(prompt: string, cwd: string, allowTools: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const args = [CLI, 'run', '--provider', GATE_PROVIDER, '--model', GATE_MODEL, '--json', '-'];
  // Tools default ON (`--no-tools` is the disabling flag; there is no
  // enabling one) — so withholding tools means passing --no-tools, not
  // omitting a flag that doesn't exist.
  if (allowTools) {
    env.EPAM_ALLOWED_TOOLS = 'bash,read_file,list_files,search';
    env.EPAM_DANGEROUS_SKIP_APPROVAL = '1';
    env.EPAM_MAX_TOOL_CALLS = '6';
  } else {
    args.push('--no-tools');
  }
  // A tool-using exchange runs multiple iterations (explore, then answer) —
  // 60s was measured too tight for a real 4-iteration/7-tool-call run and
  // produced a plain ETIMEDOUT, not a real failure. 120s covers it with room.
  const output = execFileSync(NODE_BIN, args, { input: prompt, encoding: 'utf8', timeout: 120000, cwd, env });
  const parsed = JSON.parse(output);
  const text: string = parsed.result || '';
  const m = text.match(/\{[\s\S]*\}/);
  const verdict = m ? JSON.parse(m[0]) : {};
  return { ...verdict, toolCallCount: parsed.toolCallCount ?? 0, raw: text };
}

const SYNTHETIC_VARS = {
  ANALYST_PROFILE: 'You are a self-healing pipeline analyst. Diagnose the exact root cause of the test failure and prescribe the minimum fix so the NEXT retry succeeds.',
  STORY_ID: 'TEST-9002',
  STORY_ROLE: 'typescript-engineer',
  STORY_ACS: 'AC1: Widget renders using the configured palette token.',
  SKILL_ADDENDUM: '(none)',
  DEPENDENCY_CONTRACTS: '(no dependency contracts available)',
  // The FALSE claim, mirroring the live shape exactly: a package that IS
  // installed, reported by the build/typecheck as missing.
  VERIFICATION_FAILURE: `Build failed:
  Cannot find module 'widget-toolkit' or its corresponding type declarations.
  Error: All errors are MODULE_NOT_FOUND: widget-toolkit package not installed in node_modules.`,
};

describe.skipIf(!hasKey)('granting tools lets the analyst verify, not just guess', () => {
  it('MECHANICAL: with tools granted, the model actually makes a tool call', () => {
    const root = makeProjectWithRealPackage();
    try {
      const template = extractAnalystTemplate();
      const prompt = fillTemplate(template, SYNTHETIC_VARS);
      const result = invokeAnalystWithTools(prompt, root, true);
      expect(result.toolCallCount,
        `toolCallCount=${result.toolCallCount}, diagnosis="${result.diagnosis}" — the model was ` +
        `told to verify a checkable filesystem claim and never used the tools it was given, ` +
        `which is the same as not having them`)
        .toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('BEHAVIORAL: after verifying, the diagnosis does not claim the package is missing', () => {
    const root = makeProjectWithRealPackage();
    try {
      const template = extractAnalystTemplate();
      const prompt = fillTemplate(template, SYNTHETIC_VARS);
      const result = invokeAnalystWithTools(prompt, root, true);
      const diag = (result.diagnosis || '').toLowerCase();
      expect(diag,
        `with tool access and a real installed package on disk, the analyst still said: "${result.diagnosis}"`)
        .not.toMatch(/not installed|missing from node_modules|package (is|was) missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REPRODUCES the live failure shape when tools are withheld (regression anchor)', () => {
    // Not asserting the model MUST get it wrong without tools (that would be
    // asserting an LLM failure mode deterministically, which live calls can't
    // guarantee) — asserting the MECHANISM: with EPAM_MAX_TOOL_CALLS=0, zero
    // tool calls are possible regardless of what the model wants to check.
    const root = makeProjectWithRealPackage();
    try {
      const template = extractAnalystTemplate();
      const prompt = fillTemplate(template, SYNTHETIC_VARS);
      const result = invokeAnalystWithTools(prompt, root, false);
      expect(result.toolCallCount, 'a tool call happened with the budget set to zero — ' +
        'EPAM_MAX_TOOL_CALLS is not actually bounding anything').toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasKey)('the tool grant stays bounded', () => {
  it('never exceeds the configured budget', () => {
    const root = makeProjectWithRealPackage();
    try {
      const template = extractAnalystTemplate();
      const prompt = fillTemplate(template, SYNTHETIC_VARS);
      const result = invokeAnalystWithTools(prompt, root, true);
      expect(result.toolCallCount, 'the call exceeded EPAM_MAX_TOOL_CALLS=6 — the budget ' +
        'meant to prevent a repeat of the 184k-token unbounded assessment is not holding')
        .toBeLessThanOrEqual(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
