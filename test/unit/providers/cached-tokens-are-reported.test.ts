/**
 * PROMPT CACHING WAS ALREADY WORKING ON ONE MODEL AND INVISIBLE ON ALL OF THEM.
 *
 * Every writer attempt of run 20260810T024709Z recorded `cache_read_tokens: 0`, and I read that
 * as "this codebase has no prompt caching". Probing the two live models directly disproved half
 * of it:
 *
 *   MiniMax-M3 (direct API)   identical 13,676-token prefix sent twice
 *                             call 1: cached_tokens=128   call 2: cached_tokens=13,568  (99.2%)
 *   z-ai/glm-5.2 (OpenRouter) identical 23,247-token prefix, with AND without an explicit
 *                             cache_control breakpoint: cached=0, cache_write=0 both times
 *
 * So MiniMax caches automatically and we could not see it, while glm-5.2 does not cache at all
 * and no client change can make it. Telling those two apart is the entire point of this file:
 * without the number, "reduce our token spend" is guesswork, and the obvious lever (prefer a
 * model that caches for the long tool-using loop) cannot be argued for with evidence.
 *
 * The blindness was five links long, each individually reasonable:
 *
 *   1. MiniMaxProvider reads usage.prompt_tokens and ignores prompt_tokens_details
 *   2. QwenProvider (OpenRouter) does the same
 *   3. TokenUsage has no field to carry it
 *   4. run.ts emits {inputTokens, outputTokens, totalTokens} — no cache field
 *   5. claude.sh:9677 reads `.usage.cache_read_input_tokens`, an ANTHROPIC-shaped key that our
 *      OpenAI-shaped providers were never going to emit
 *
 * Link 5 is the one worth dwelling on: the consumer was reading a key nothing produces, and
 * because jq's `// 0` default turns a missing key into a plausible zero, it reported a
 * confident, wrong number forever. A missing field that defaults to a legal value is invisible.
 *
 * Fixtures are the REAL response shapes captured from the probes above, not invented ones.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MiniMaxProvider } from '../../../src/providers/minimax/MiniMaxProvider';
import { QwenProvider } from '../../../src/providers/qwen/QwenProvider';
import { buildRunResultJson } from '../../../src/cli/commands/run';

afterEach(() => vi.unstubAllGlobals());

/** The exact usage object MiniMax-M3 returned on the second identical-prefix call. */
const MINIMAX_USAGE = {
  total_tokens: 13684,
  total_characters: 0,
  prompt_tokens: 13676,
  completion_tokens: 8,
  completion_tokens_details: { reasoning_tokens: 7 },
  prompt_tokens_details: { cached_tokens: 13568 },
};

/** The exact usage object z-ai/glm-5.2 returned via OpenRouter — caching absent, not missing. */
const OPENROUTER_USAGE = {
  prompt_tokens: 23259,
  completion_tokens: 3,
  total_tokens: 23262,
  cost: 0.0176841,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
};

function stubFetch(usage: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage,
    }),
  })));
}

const REQ = { model: 'x', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8 };

describe('the provider surfaces the number the API already returns', () => {
  it('MiniMax reports cached input tokens', async () => {
    stubFetch(MINIMAX_USAGE);
    const r = await new MiniMaxProvider('k').complete(REQ);
    expect(
      r.usage.cachedInputTokens,
      'a 99.2% cache hit was measured live and reported to the pipeline as zero',
    ).toBe(13568);
  });

  it('MiniMax still reports total input tokens unchanged', async () => {
    stubFetch(MINIMAX_USAGE);
    const r = await new MiniMaxProvider('k').complete(REQ);
    // Cached tokens are a SUBSET of prompt_tokens, not an addition to them. Adding them would
    // double-count the cached portion into the cost estimate.
    expect(r.usage.inputTokens).toBe(13676);
  });

  it('OpenRouter reports zero distinctly from absent', async () => {
    stubFetch(OPENROUTER_USAGE);
    const r = await new QwenProvider({ apiKey: 'k', openRouterMode: true }).complete(REQ);
    expect(r.usage.cachedInputTokens, 'a measured zero is a finding, not a gap').toBe(0);
  });

  it('a provider that reports no cache detail leaves the field undefined, not 0', async () => {
    // undefined = "this API said nothing". 0 = "this API said none were cached". Collapsing
    // them is what made link 5 undetectable for the life of the pipeline.
    stubFetch({ prompt_tokens: 100, completion_tokens: 5 });
    const r = await new MiniMaxProvider('k').complete(REQ);
    expect(r.usage.cachedInputTokens).toBeUndefined();
  });
});

describe('the CLI emits it in the shape the pipeline already reads', () => {
  const usage = (cached?: number) => ({ inputTokens: 13676, outputTokens: 8, cachedInputTokens: cached });

  it('emits cache_read_input_tokens — the key claude.sh:9677 actually looks for', () => {
    const o = buildRunResultJson({
      finalResponse: 'done', usage: usage(13568), toolCallCount: 3, iterations: 2,
    } as never, { model: 'MiniMax-M3', provider: 'minimax' } as never);
    expect((o.usage as Record<string, unknown>).cached_input_tokens).toBe(13568);
  });

  it('omits the key when the provider reported nothing, so absent stays absent', () => {
    const o = buildRunResultJson({
      finalResponse: 'done', usage: usage(undefined), toolCallCount: 0, iterations: 1,
    } as never, { model: 'x', provider: 'y' } as never);
    expect((o.usage as Record<string, unknown>).cached_input_tokens).toBeUndefined();
  });

  it('does not disturb the existing token fields any consumer depends on', () => {
    const o = buildRunResultJson({
      finalResponse: 'd', usage: usage(13568), toolCallCount: 0, iterations: 1,
    } as never, { model: 'x', provider: 'y' } as never);
    const u = o.usage as Record<string, number>;
    expect(u.inputTokens).toBe(13676);
    expect(u.outputTokens).toBe(8);
    expect(u.totalTokens).toBe(13684);
  });
});

describe('claude.sh reads what the CLI now writes, WITHOUT double-counting it', () => {
  const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
  const SRC = readFileSync(CLAUDE_SH, 'utf8');

  /**
   * Executes the pipeline's real token-accounting block against a result file.
   *
   * The block is lifted from claude.sh rather than restated, so a change there that reintroduces
   * the double-count fails here. It ends at the `fi` that closes the json_result_file branch.
   */
  function account(resultJson: string): { tokensIn: number; cacheRead: number } {
    const start = SRC.indexOf("tokens_in=$(jq -r '.usage.input_tokens");
    expect(start, 'the accounting block moved — re-anchor this test').toBeGreaterThan(-1);
    const end = SRC.indexOf('\n    fi\n', start);
    const block = SRC.slice(start, end);
    const dir = mkdtempSync(join(tmpdir(), 'cacheacct-'));
    try {
      const f = join(dir, 'result.json');
      writeFileSync(f, resultJson);
      // Wrapped in a function because the block uses `local`, exactly as it does in claude.sh.
      // Run at top level, `local` errors and the assignments silently do not happen — which
      // reads as "the accounting produced 0" and would make these assertions lie.
      const out = execFileSync('bash', ['-c',
        `set -u\njson_result_file=${JSON.stringify(f)}\n` +
        `_acct() {\n${block}\n  printf "%s %s" "\${tokens_in:-0}" "\${cache_read:-0}"\n}\n_acct`],
        { encoding: 'utf8' });
      const [a, b] = out.trim().split(/\s+/);
      return { tokensIn: Number(a), cacheRead: Number(b) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const cliOutput = (inputTokens: number, cached?: number) => JSON.stringify(
    buildRunResultJson({
      finalResponse: 'd', usage: { inputTokens, outputTokens: 8, cachedInputTokens: cached },
      toolCallCount: 0, iterations: 1,
    } as never, { model: 'x', provider: 'y' } as never));

  it('records a real cache hit — the number that was a permanent zero', () => {
    expect(account(cliOutput(13676, 13568)).cacheRead).toBe(13568);
  });

  it('THE HAZARD: cached tokens are NOT added to input tokens', () => {
    // OpenAI-shaped prompt_tokens already includes them. Adding would report 27,244 for a call
    // that consumed 13,676 — inflating the record AND the $15 budget guard that sums it.
    expect(
      account(cliOutput(13676, 13568)).tokensIn,
      'the cached portion was counted twice',
    ).toBe(13676);
  });

  it('a measured zero is recorded as zero, not as absent', () => {
    const r = account(cliOutput(23259, 0));
    expect(r.cacheRead).toBe(0);
    expect(r.tokensIn).toBe(23259);
  });

  it('a provider that reports nothing leaves the accounting exactly as it was', () => {
    const r = account(cliOutput(100));
    expect(r.tokensIn).toBe(100);
    expect(r.cacheRead).toBe(0);
  });

  it('the Anthropic path still adds, because there input_tokens EXCLUDES cached', () => {
    // The Claude-CLI shape must keep working — its semantics are genuinely different.
    const r = account(JSON.stringify({
      usage: { input_tokens: 1000, output_tokens: 10,
               cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 },
    }));
    expect(r.tokensIn, 'the Anthropic accounting regressed').toBe(6200);
  });
});
