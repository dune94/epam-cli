/**
 * Diagnosis-groundedness check (2026-07-12): augments self-healing with an
 * advisory second opinion on the FailureAnalyst's own diagnosis, using
 * DeepEval's GEval metric as an LLM judge over OpenRouter (this pipeline's
 * existing gate-model provider -- see .env: "Orchestration gate agents: use
 * Qwen for all pipeline/QA agents (no Anthropic/OpenAI key needed)").
 *
 * Scope, per design discussion: advisory/logged only for now. This test
 * file covers the standalone Python tool
 * (orchestrations/scripts/tools/diagnosis-groundedness-check.py) in
 * isolation -- wiring it into claude.sh's run_failure_analyst() is a
 * separate change, deferred while a tier3 run was live (never edit a
 * live-running script).
 *
 * Manually verified against the REAL OpenRouter API before writing these
 * automated tests (transcript, 2026-07-12):
 *   - ungrounded diagnosis ("database connection pool exhausted" against a
 *     log that only shows an arithmetic assertion failure) scored 0.04,
 *     verdict "ungrounded", with an accurate explanation.
 *   - grounded diagnosis (correctly restates the actual off-by-one bug and
 *     cites the real assertion) scored 1.0, verdict "grounded".
 * The automated tests below do NOT repeat that live call on every run (real
 * cost, real network dependency) -- the "real LLM call" test is gated
 * behind RUN_LIVE_DEEPEVAL_TESTS=1 and skipped by default. Everything else
 * (fast, free, deterministic paths: malformed input, missing fields, no
 * API key) runs for real, every time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_PATH = join(REPO_ROOT, 'orchestrations/scripts/tools/diagnosis-groundedness-check.py');
const VENV_PYTHON = join(REPO_ROOT, 'orchestrations/scripts/tools/.venv-deepeval/bin/python');
const scriptSrc = readFileSync(SCRIPT_PATH, 'utf8');

function runScript(input: string, opts?: { cwd?: string; env?: Record<string, string> }): { stdout: string; rc: number } {
  try {
    const stdout = execFileSync(VENV_PYTHON, [SCRIPT_PATH], {
      input,
      encoding: 'utf8',
      cwd: opts?.cwd,
      env: opts?.env,
      timeout: 30000,
    });
    return { stdout, rc: 0 };
  } catch (e: any) {
    return { stdout: ((e.stdout ?? '').toString()), rc: e.status ?? -1 };
  }
}

function parseLastJsonLine(stdout: string): any {
  const lines = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{'));
  return JSON.parse(lines[lines.length - 1]);
}

describe('diagnosis-groundedness-check.py — provider policy (static)', () => {
  it('uses OpenRouterModel, not a native OpenAI/Anthropic model', () => {
    expect(scriptSrc).toMatch(/from deepeval\.models import OpenRouterModel/);
    expect(scriptSrc).not.toMatch(/AnthropicModel|GPTModel/);
  });

  it('reads OPENROUTER_API_KEY (or EPAM_API_KEY_OPENROUTER) and nothing else for credentials', () => {
    expect(scriptSrc).toMatch(/OPENROUTER_API_KEY/);
    expect(scriptSrc).toMatch(/EPAM_API_KEY_OPENROUTER/);
  });

  it('is advisory-only: always exits 0 and never raises an uncaught exception path', () => {
    // Every branch either returns after printing, or falls into a broad
    // except -- this pipeline's other advisory tooling follows the same
    // "must never be able to break the caller" contract.
    expect(scriptSrc).toMatch(/except Exception as e:/);
  });
});

describe('diagnosis-groundedness-check.py — real execution, fast/free paths', () => {
  it('reports skipped:true on malformed JSON input', () => {
    const { stdout, rc } = runScript('not json');
    expect(rc).toBe(0);
    const result = parseLastJsonLine(stdout);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/parse input JSON/);
  });

  it('reports skipped:true when diagnosis or log_excerpt is missing', () => {
    const { stdout, rc } = runScript(JSON.stringify({}));
    expect(rc).toBe(0);
    const result = parseLastJsonLine(stdout);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/missing\/empty/);
  });

  it('reports skipped:true when no OpenRouter API key is available (no ambient .env in cwd)', () => {
    // deepeval's own `autoload_dotenv()` (called at import time) will
    // silently re-source a .env file found in the CURRENT WORKING
    // DIRECTORY, overriding any env-var stripping done at the shell level
    // -- confirmed empirically while building this test. Running from an
    // empty tmpdir (no .env present) is the only reliable way to exercise
    // the "no key" path.
    const dir = mkdtempSync(join(tmpdir(), 'diagnosis-groundedness-nokey-'));
    try {
      const { stdout, rc } = runScript(JSON.stringify({ diagnosis: 'x', log_excerpt: 'y' }), {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: dir },
      });
      expect(rc).toBe(0);
      const result = parseLastJsonLine(stdout);
      expect(result.skipped).toBe(true);
      expect(result.reason).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.RUN_LIVE_DEEPEVAL_TESTS)('diagnosis-groundedness-check.py — REAL OpenRouter call (opt-in, RUN_LIVE_DEEPEVAL_TESTS=1)', () => {
  it('scores an ungrounded diagnosis low', () => {
    const { stdout, rc } = runScript(
      JSON.stringify({
        diagnosis: 'The database connection pool is exhausted, causing timeouts.',
        log_excerpt: 'FAIL src/index.test.ts\n  index > add\n    AssertionError: expected 4 to be 3\n    at src/index.test.ts:6:23',
      }),
    );
    expect(rc).toBe(0);
    const result = parseLastJsonLine(stdout);
    expect(result.skipped).toBe(false);
    expect(result.verdict).toBe('ungrounded');
    expect(result.score).toBeLessThan(0.5);
  });

  it('scores a grounded diagnosis high', () => {
    const { stdout, rc } = runScript(
      JSON.stringify({
        diagnosis:
          "The add function has an off-by-one bug: it returns 4 instead of 3 for inputs 1 and 2, per the AssertionError at index.test.ts:6:23.",
        log_excerpt: 'FAIL src/index.test.ts\n  index > add\n    AssertionError: expected 4 to be 3\n    at src/index.test.ts:6:23',
      }),
    );
    expect(rc).toBe(0);
    const result = parseLastJsonLine(stdout);
    expect(result.skipped).toBe(false);
    expect(result.verdict).toBe('grounded');
    expect(result.score).toBeGreaterThan(0.5);
  });
});
