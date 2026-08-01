/**
 * LIVE integration test — proves prd-change-reviewer's tool grant actually
 * gets used to verify a stack/tech claim against the real codebase, without
 * running a full pipeline.
 *
 * Full agent audit, 2026-07-31 (same class as HEAL-BLIND). The reviewer's own
 * profile requires judging profile_addendum/profile_creation changes "from
 * the manifests, config and source actually present in THIS codeline" — but
 * neither of its two call sites (claude.sh's run_prd_change_reviewer,
 * spec-mode-runner.js's reviewPrdChange) granted any tool access. A live
 * incident already occurred via a DIFFERENT root cause (a frozen stack
 * allowlist baked into the profile text itself, since removed — see
 * reviewer-no-stack-hardcoding.test.ts) that rejected correct Contentstack
 * advice for Metrolinx. Removing that frozen list fixed the SYMPTOM; this
 * fixes the underlying mechanism — the reviewer still had no way to check a
 * stack claim against reality, it just didn't need to that time because the
 * wrong answer was hardcoded instead of reasoned.
 *
 * Fixed by granting AI_GATE_ALLOW_TOOLS=1 + the same shared read-only
 * allowlist every other gate agent draws from, bounded with
 * EPAM_MAX_TOOL_CALLS, at both call sites.
 *
 * TWO LAYERS OF ASSERTION:
 *   1. MECHANICAL: with tools granted, does the model make a tool call when
 *      judging a profile_addendum change that references a real dependency?
 *   2. BEHAVIORAL: does a profile_addendum naming a package that IS actually
 *      installed get approved (not incorrectly rejected as "a technology
 *      this project does not already use") once the model can check.
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
const PROFILES_FILE = join(REPO_ROOT, 'orchestrations/agents/profiles.json');

const GATE_PROVIDER = process.env.ORCH_GATE_PROVIDER || 'qwen';
const GATE_MODEL = process.env.ORCH_GATE_MODEL || 'z-ai/glm-5.2';
const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.EPAM_API_KEY_OPENROUTER);

function reviewerProfileText(): string {
  const profiles = JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
  const text = profiles['prd-change-reviewer'];
  expect(text, 'prd-change-reviewer profile is missing from profiles.json').toBeTruthy();
  return text;
}

/** A synthetic project with a REAL, verifiable installed package. */
function makeProjectWithRealPackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-tool-verify-'));
  mkdirSync(join(root, 'node_modules', 'widget-toolkit'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'widget-toolkit', 'package.json'),
    JSON.stringify({ name: 'widget-toolkit', version: '1.0.0' }));
  writeFileSync(join(root, 'package.json'),
    JSON.stringify({ name: 'mock-app', dependencies: { 'widget-toolkit': '^1.0.0' } }));
  return root;
}

function buildPrompt(): string {
  const before = { addendum: '' };
  const after = { addendum: 'Do not call widget-toolkit\'s renderWidget() without a paletteToken — it throws.' };
  return `${reviewerProfileText()}

STORY: TEST-9003
CHANGE TYPE: profile_addendum

BEFORE:
${JSON.stringify(before)}

AFTER:
${JSON.stringify(after)}

You have read-only tools available (list/search/read files, run read-only shell commands). Several of your rejection rules ("introduces a technology this project does not already use," "TC fact cannot be verified by reading source code") require checking a claim against the real manifests/config/source of THIS codeline — do not judge those from the before/after excerpts alone. Verify before rejecting on that basis.

Emit ONLY: {"verdict":"pass|fail","issues":["<issue1>"],"reason":"<15 words max>"}`;
}

function invokeReviewer(prompt: string, cwd: string, allowTools: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const args = [CLI, 'run', '--provider', GATE_PROVIDER, '--model', GATE_MODEL, '--json', '-'];
  if (allowTools) {
    env.EPAM_ALLOWED_TOOLS = 'bash,read_file,list_files,search';
    env.EPAM_DANGEROUS_SKIP_APPROVAL = '1';
    env.EPAM_MAX_TOOL_CALLS = '6';
  } else {
    args.push('--no-tools');
  }
  const output = execFileSync(NODE_BIN, args, { input: prompt, encoding: 'utf8', timeout: 120000, cwd, env });
  const parsed = JSON.parse(output);
  const text: string = parsed.result || '';
  const m = text.match(/\{[\s\S]*\}/);
  const verdict = m ? JSON.parse(m[0]) : {};
  return { ...verdict, toolCallCount: parsed.toolCallCount ?? 0, raw: text };
}

describe.skipIf(!hasKey)('granting tools lets prd-change-reviewer verify a stack claim, not just guess', () => {
  it('MECHANICAL: with tools granted, the model makes a tool call to check the real package.json', () => {
    const root = makeProjectWithRealPackage();
    try {
      const result = invokeReviewer(buildPrompt(), root, true);
      expect(result.toolCallCount,
        `toolCallCount=${result.toolCallCount}, verdict="${result.verdict}" — the model was told ` +
        `to verify a checkable stack claim and never used the tools it was given`)
        .toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('BEHAVIORAL: a real, installed dependency is not rejected as unused', () => {
    const root = makeProjectWithRealPackage();
    try {
      const result = invokeReviewer(buildPrompt(), root, true);
      expect(result.verdict,
        `with tool access and a real installed dependency, the reviewer still said: ${JSON.stringify(result.issues)}`)
        .toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
