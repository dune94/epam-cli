/**
 * LIVE integration test — proves codeline-bridge-agent's tool grant actually
 * gets used to read a real source file and WRITE a real contract file,
 * without running a full multi-codeline pipeline.
 *
 * Full agent audit, 2026-07-31: codeline-bridge-agent's profile explicitly
 * requires reading BRIDGE_PRD_FILE + source files in BRIDGE_SRC_DIR, then
 * writing BRIDGE_OUT_FILE "exactly once using WriteFile" — but the call site
 * (`run-agent-orchestration.sh:2446`, via plain `run_orch_prompt`) granted no
 * tools at all. Under the pipeline's actual configured gate providers
 * (openrouter/openai) that means `--no-tools`. Live-corroborated: an archived
 * agent-activity.jsonl showed repeated retry cost entries for the same
 * story/lane — the exact signature of an agent told to WriteFile with
 * nothing to do it with. Same bug class as HEAL-BLIND (failure-analyst).
 *
 * Fixed by granting AI_GATE_ALLOW_TOOLS=1 with no restricted allowlist (this
 * agent genuinely needs write_file, unlike the read-only QA gates), bounded
 * with EPAM_MAX_TOOL_CALLS. This test proves the fix actually works end to
 * end against the real model — not just that the source text changed.
 *
 * TWO LAYERS OF ASSERTION:
 *   1. MECHANICAL (deterministic): with tools granted, does the model
 *      actually make tool calls (toolCallCount from the CLI's own --json
 *      output) when asked to read a real file and write a real one?
 *   2. BEHAVIORAL (best-effort, live): does BRIDGE_OUT_FILE actually appear
 *      on disk with real content extracted from the real source file — not
 *      just narrated in the response text (the exact prior failure mode:
 *      "I have written the file" with nothing on disk).
 *
 * Requires OPENROUTER_API_KEY and a built dist/epam.js. Skipped automatically
 * if either is missing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../');
const CLI = join(REPO_ROOT, 'dist/epam.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const PROFILES_FILE = join(REPO_ROOT, 'orchestrations/agents/profiles.json');

const GATE_PROVIDER = process.env.ORCH_GATE_PROVIDER || 'openrouter';
const GATE_MODEL = process.env.ORCH_GATE_MODEL || 'z-ai/glm-5.2';
const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.EPAM_API_KEY_OPENROUTER);

function bridgeProfileText(): string {
  const profiles = JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
  const text = profiles['codeline-bridge-agent'];
  expect(text, 'codeline-bridge-agent profile is missing from profiles.json').toBeTruthy();
  return text;
}

/** A synthetic completed codeline with one real exported function. */
function makeBridgeProject() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-tool-verify-'));
  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'widget-service.ts'),
    [
      'export interface WidgetOptions {',
      '  paletteToken: string;',
      '}',
      '',
      '/** Renders a widget using the configured palette token. */',
      'export function renderWidget(options: WidgetOptions): string {',
      '  return `<widget palette="${options.paletteToken}" />`;',
      '}',
    ].join('\n'),
  );
  const prdFile = join(root, 'bridge-prd.json');
  writeFileSync(
    prdFile,
    JSON.stringify({
      stories: [
        { id: 'TEST-9001', technicalNotes: { files: [join(srcDir, 'widget-service.ts')] } },
      ],
    }),
  );
  const outFile = join(root, 'cross-codeline-mock-src.md');
  return { root, srcDir, prdFile, outFile };
}

function buildPrompt(vars: { srcDir: string; prdFile: string; outFile: string }): string {
  return `${bridgeProfileText()}

## Variables for this run

- BRIDGE_SRC_CODELINE: mock-src
- BRIDGE_SRC_DIR: ${vars.srcDir}
- BRIDGE_OUT_FILE: ${vars.outFile}
- BRIDGE_PRD_FILE: ${vars.prdFile}

Extract the exported API surface from the 'mock-src' codeline files and write the cross-codeline contract to ${vars.outFile}.`;
}

function invokeBridgeAgent(prompt: string, cwd: string, allowTools: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const args = [CLI, 'run', '--provider', GATE_PROVIDER, '--model', GATE_MODEL, '--json', '-'];
  if (allowTools) {
    env.EPAM_DANGEROUS_SKIP_APPROVAL = '1';
    env.EPAM_MAX_TOOL_CALLS = '10';
  } else {
    args.push('--no-tools');
  }
  const output = execFileSync(NODE_BIN, args, { input: prompt, encoding: 'utf8', timeout: 120000, cwd, env });
  const parsed = JSON.parse(output);
  return { toolCallCount: parsed.toolCallCount ?? 0, raw: parsed.result || '' };
}

describe.skipIf(!hasKey)('granting tools lets codeline-bridge-agent actually read and write, not just narrate', () => {
  it('MECHANICAL: with tools granted, the model makes tool calls to read the source and write the contract', () => {
    const { root, srcDir, prdFile, outFile } = makeBridgeProject();
    try {
      const prompt = buildPrompt({ srcDir, prdFile, outFile });
      const result = invokeBridgeAgent(prompt, root, true);
      expect(result.toolCallCount,
        `toolCallCount=${result.toolCallCount} — the agent was told to read a real file and ` +
        `WriteFile a real contract, and never used the tools it was given`)
        .toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('BEHAVIORAL: BRIDGE_OUT_FILE actually appears on disk with real extracted content', () => {
    const { root, srcDir, prdFile, outFile } = makeBridgeProject();
    try {
      const prompt = buildPrompt({ srcDir, prdFile, outFile });
      invokeBridgeAgent(prompt, root, true);
      expect(existsSync(outFile),
        'the model narrated a response but BRIDGE_OUT_FILE was never actually written — ' +
        'this is the exact prior failure mode ("I have written the file" with nothing on disk)')
        .toBe(true);
      const contract = readFileSync(outFile, 'utf8');
      expect(contract).toMatch(/renderWidget/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REPRODUCES the live failure shape when tools are withheld (regression anchor)', () => {
    const { root, srcDir, prdFile, outFile } = makeBridgeProject();
    try {
      const prompt = buildPrompt({ srcDir, prdFile, outFile });
      invokeBridgeAgent(prompt, root, false);
      expect(existsSync(outFile),
        'the contract file exists even with tools withheld — the mechanism check below is invalid')
        .toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
