/**
 * run_provider_once() — ai-run.sh's core provider dispatch (105 of the file's
 * 219 lines), found completely untested (2026-07-07 test-coverage audit)
 * despite being the single chokepoint every orchestration-level LLM call
 * (spec-mode, failure-analyst, review-agent, gate agents, story
 * implementation itself) ultimately routes through. Existing "tests" for
 * ai-run.sh were static `grep` checks on the source text only — this file
 * actually EXECUTES the function against stubbed CLI binaries (claude, codex,
 * epam), no real network/API calls.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const AI_RUN_SH = join(REPO_ROOT, 'orchestrations/scripts/llm-handler.sh');
const aiRunSrc = readFileSync(AI_RUN_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = aiRunSrc.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

describe('run_provider_once — REAL execution', () => {
  function run(opts: {
    provider: string;
    stubs?: Record<string, string>; // binary name -> script content
    env?: Record<string, string>;
    stdin?: string;
  }): { stdout: string; stderr: string; rc: number; sideChannel: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ai-run-provider-test-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      for (const [name, content] of Object.entries(opts.stubs ?? {})) {
        const p = join(binDir, name);
        writeFileSync(p, content);
        chmodSync(p, 0o755);
      }

      const fnBody = extractFunctionByLineAnchor('run_provider_once');
      const scriptPath = join(dir, 'run.sh');
      const promptFile = join(dir, 'prompt.txt');
      const errFile = join(dir, 'stderr.txt');
      const sideChannelFile = join(dir, 'side-channel.txt');
      writeFileSync(promptFile, opts.stdin ?? 'test prompt');
      writeFileSync(sideChannelFile, '');

      const envLines = Object.entries(opts.env ?? {})
        .filter(([k]) => !['EPAM_CLI', 'CLAUDE_CMD', 'AI_MODEL'].includes(k))
        .map(([k, v]) => `export ${k}="${v}"`);
      writeFileSync(
        scriptPath,
        [
          // Controlled, MINIMAL PATH — this system has real `codex`, `epam`,
          // and `jq` binaries installed in various real locations (fnm node
          // installs, ~/.local/bin), so merely PREPENDING a stub dir doesn't
          // actually exclude them for "binary not installed" scenarios.
          // ~/.local/bin is kept (for the real jq, used pervasively) but does
          // NOT contain codex on this system; stub binaries in binDir always
          // take precedence since it's listed first.
          `export PATH="${binDir}:${process.env.HOME}/.local/bin:/usr/bin:/bin"`,
          `EPAM_CLI="${opts.env?.EPAM_CLI ?? 'epam'}"`,
          `CLAUDE_CMD="${opts.env?.CLAUDE_CMD ?? 'claude'}"`,
          `AI_MODEL="${opts.env?.AI_MODEL ?? ''}"`,
          `PROMPT_FILE="${promptFile}"`,
          `export AI_RUN_TEST_SIDE_CHANNEL="${sideChannelFile}"`,
          ...envLines,
          fnBody,
          `run_provider_once "${opts.provider}" 2> "${errFile}"`,
          `echo "RC=$?"`,
        ].join('\n'),
      );
      let stdout = '';
      let rc = 0;
      try {
        stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString();
      }
      let stderr = '';
      try {
        stderr = readFileSync(errFile, 'utf8');
      } catch {
        stderr = '';
      }
      let sideChannel = '';
      try {
        sideChannel = readFileSync(sideChannelFile, 'utf8');
      } catch {
        sideChannel = '';
      }
      const rcMatch = stdout.match(/RC=(\d+)/);
      rc = rcMatch ? parseInt(rcMatch[1], 10) : -1;
      stdout = stdout.replace(/RC=\d+\n?$/, '');
      return { stdout, stderr, rc, sideChannel };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe('claude provider', () => {
    it('plain text output path (no SDK, no JSON-result capture)', () => {
      const { stdout, rc } = run({
        provider: 'claude',
        stubs: {
          claude: `#!/usr/bin/env bash\ncat > /dev/null\necho "claude plain text response"\n`,
        },
      });
      expect(rc).toBe(0);
      expect(stdout).toContain('claude plain text response');
    });

    it('ORCH_JSON_RESULT set: extracts .result via jq AND saves the full JSON to the target file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ai-run-json-result-'));
      try {
        const jsonResultFile = join(dir, 'result.json');
        const { stdout, rc } = run({
          provider: 'claude',
          stubs: {
            claude: `#!/usr/bin/env bash\ncat > /dev/null\necho '{"result":"structured claude response"}'\n`,
          },
          env: { ORCH_JSON_RESULT: jsonResultFile },
        });
        expect(rc).toBe(0);
        expect(stdout).toContain('structured claude response');
        const saved = JSON.parse(readFileSync(jsonResultFile, 'utf8'));
        expect(saved.result).toBe('structured claude response');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('passes --model when AI_MODEL is set', () => {
      const { stdout } = run({
        provider: 'claude',
        stubs: {
          claude: `#!/usr/bin/env bash\ncat > /dev/null\nfor a in "$@"; do echo "ARG:$a"; done\n`,
        },
        env: { AI_MODEL: 'claude-sonnet-5' },
      });
      expect(stdout).toContain('ARG:--model');
      expect(stdout).toContain('ARG:claude-sonnet-5');
    });
  });

  describe('codemie-claude provider', () => {
    it('passes through to the codemie-claude binary', () => {
      const { stdout, rc } = run({
        provider: 'codemie-claude',
        stubs: {
          'codemie-claude': `#!/usr/bin/env bash\ncat > /dev/null\necho "codemie response"\n`,
        },
      });
      expect(rc).toBe(0);
      expect(stdout).toContain('codemie response');
    });
  });

  describe('codex provider', () => {
    it('returns 127 with a clear message when the codex binary is not installed', () => {
      const { rc, stderr } = run({ provider: 'codex', stubs: {} });
      expect(rc).toBe(127);
      expect(stderr).toContain("requires codex CLI");
    });

    it('extracts joined text from item.completed JSON stream lines on success', () => {
      const { stdout, rc } = run({
        provider: 'codex',
        stubs: {
          codex: `#!/usr/bin/env bash
cat > /dev/null
echo '{"type":"item.completed","item":{"text":"Hello "}}'
echo '{"type":"item.completed","item":{"text":"World"}}'
echo '{"type":"other.event"}'
exit 0
`,
        },
        // THE LADDER RESOLVES THE MODEL; THIS ARM NO LONGER INVENTS ONE.
        // With AI_MODEL unset the codex arm returns 78 ("no model resolved from the ladder")
        // instead of defaulting to a literal, so a test that left it unset was exercising the
        // refusal, not the success path it describes.
        env: { AI_MODEL: 'gpt-5-codex' },
      });
      expect(rc).toBe(0);
      expect(stdout.trim()).toBe('Hello World');
    });

    it('REFUSES a model it cannot serve, rather than substituting one of its own', () => {
      // THE FALLBACK WAS THE DEFECT. This asserted the arm silently swaps in gpt-5-codex when
      // the resolved model is not codex-shaped, so a run that had resolved one model called a
      // different one chosen here, with nothing in the log to say so. A provider that cannot
      // serve the ladder's model is a routing error, not a licence to pick another: it returns
      // 78 and lets the ladder escalate to a rung this provider CAN serve.
      // run_provider_once's codex branch only surfaces stdout that survives its
      // own item.completed/jq post-processing, so args must be captured via a
      // side-channel file rather than echoed directly to stdout.
      const { sideChannel, rc } = run({
        provider: 'codex',
        stubs: {
          codex: `#!/usr/bin/env bash
cat > /dev/null
for a in "$@"; do echo "$a" >> "$AI_RUN_TEST_SIDE_CHANNEL"; done
echo '{"type":"item.completed","item":{"text":"ok"}}'
exit 0
`,
        },
        env: { AI_MODEL: 'some-unrelated-model-name' },
      });
      expect(rc, 'the codex arm accepted a model it cannot serve').toBe(78);
      expect(sideChannel, 'codex was invoked — the refusal must happen BEFORE the call')
        .not.toContain('gpt-5-codex');
    });

    it('keeps AI_MODEL as-is when it DOES match the codex/gpt/o-series pattern', () => {
      const { sideChannel, rc } = run({
        provider: 'codex',
        stubs: {
          codex: `#!/usr/bin/env bash
cat > /dev/null
for a in "$@"; do echo "$a" >> "$AI_RUN_TEST_SIDE_CHANNEL"; done
echo '{"type":"item.completed","item":{"text":"ok"}}'
exit 0
`,
        },
        env: { AI_MODEL: 'o3-mini' },
      });
      expect(rc).toBe(0);
      expect(sideChannel).toContain('o3-mini');
    });

    it('returns 1 and prints the raw output to stderr when codex exec itself fails', () => {
      const { rc, stderr } = run({
        provider: 'codex',
        stubs: {
          codex: `#!/usr/bin/env bash\ncat > /dev/null\necho "codex crashed: bad request"\nexit 1\n`,
        },
        env: { AI_MODEL: 'gpt-5-codex' },
      });
      expect(rc).toBe(1);
      expect(stderr).toContain('codex crashed');
    });
  });

  describe('epam CLI umbrella providers (openai|openrouter|cursor|copilot|minimax)', () => {
    it('extracts .result from the last JSON line with a non-null result (success path)', () => {
      const { stdout, rc } = run({
        provider: 'openrouter',
        stubs: {
          epam: `#!/usr/bin/env bash
cat > /dev/null
echo '{"level":30,"msg":"pino log line, not a result"}'
echo '{"result":"the real answer"}'
exit 0
`,
        },
      });
      expect(rc).toBe(0);
      expect(stdout.trim()).toBe('the real answer');
    });

    it('returns 1 and captures stderr when the epam CLI call itself fails', () => {
      // The epam-umbrella branch redirects the underlying call's OWN stderr to
      // /dev/null (it only exists to keep pino logs out of jq's way) and instead
      // forwards captured STDOUT to the caller's stderr on failure — so the stub
      // must write the diagnostic to stdout, not stderr, to match real behavior.
      const { rc, stderr } = run({
        provider: 'openrouter',
        stubs: {
          epam: `#!/usr/bin/env bash\ncat > /dev/null\necho "epam internal error"\nexit 1\n`,
        },
      });
      expect(rc).toBe(1);
      expect(stderr).toContain('epam internal error');
    });

    it('uses --no-tools by default (AI_GATE_ALLOW_TOOLS unset)', () => {
      // run_provider_once's epam-umbrella branch pipes stdout through a jq
      // filter that only keeps lines with a non-empty .result, so args must
      // be captured via the side channel rather than echoed to stdout.
      const { sideChannel } = run({
        provider: 'openrouter',
        stubs: {
          epam: `#!/usr/bin/env bash
cat > /dev/null
for a in "$@"; do echo "ARG:$a" >> "$AI_RUN_TEST_SIDE_CHANNEL"; done
echo '{"result":"ok"}'
`,
        },
      });
      expect(sideChannel).toContain('ARG:--no-tools');
    });

    it('omits --no-tools when AI_GATE_ALLOW_TOOLS=1 (QA gate agents need file-read tools)', () => {
      const { sideChannel } = run({
        provider: 'openrouter',
        stubs: {
          epam: `#!/usr/bin/env bash
cat > /dev/null
for a in "$@"; do echo "ARG:$a" >> "$AI_RUN_TEST_SIDE_CHANNEL"; done
echo '{"result":"ok"}'
`,
        },
        env: { AI_GATE_ALLOW_TOOLS: '1' },
      });
      expect(sideChannel).not.toContain('ARG:--no-tools');
    });

    it('saves the last non-empty-result JSON object to ORCH_JSON_RESULT when set', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ai-run-epam-json-'));
      try {
        const jsonResultFile = join(dir, 'result.json');
        run({
          provider: 'minimax',
          stubs: {
            epam: `#!/usr/bin/env bash
cat > /dev/null
echo '{"result":""}'
echo '{"result":"final answer","usage":{"input_tokens":10}}'
`,
          },
          env: { ORCH_JSON_RESULT: jsonResultFile },
        });
        const saved = JSON.parse(readFileSync(jsonResultFile, 'utf8'));
        expect(saved.result).toBe('final answer');
        expect(saved.usage.input_tokens).toBe(10);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('unsupported provider', () => {
    it('returns 2 with a clear "unsupported provider" message', () => {
      const { rc, stderr } = run({ provider: 'totally-unknown-provider' });
      expect(rc).toBe(2);
      expect(stderr).toContain("unsupported provider 'totally-unknown-provider'");
    });
  });
});

describe('retryable_failure — REAL execution', () => {
  function check(text: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), 'retryable-test-'));
    try {
      const fnBody = extractFunctionByLineAnchor('retryable_failure');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nretryable_failure "${text.replace(/"/g, '\\"')}"\necho "RC=$?"`);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      return output.includes('RC=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    'Error: rate limit exceeded',
    'You have hit your limit for this billing period',
    'Too many requests, please slow down',
    'RESOURCE_EXHAUSTED: quota exceeded',
    'Request timeout after 30s',
    'QUOTA EXCEEDED (case-insensitive match)',
  ])('recognizes "%s" as retryable', (text) => {
    expect(check(text)).toBe(true);
  });

  it.each(['Invalid API key provided', 'Syntax error in generated code', 'File not found'])(
    'does NOT treat "%s" as retryable',
    (text) => {
      expect(check(text)).toBe(false);
    },
  );
});
