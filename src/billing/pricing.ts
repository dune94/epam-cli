export interface ModelPricing {
  inputPerMillion: number;  // USD per 1M input tokens
  outputPerMillion: number; // USD per 1M output tokens
}

// Prices as of early 2026 — update as providers change
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ─── Anthropic ────────────────────────────────────────────────────────────
  'claude-opus-4-6':              { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-opus-4-5':              { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-opus-4-6-fast':         { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-sonnet-4-6':            { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-sonnet-4-5':            { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-sonnet-4':              { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-3-7-sonnet-20250219':   { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-3-5-sonnet-20241022':   { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-haiku-4-5':             { inputPerMillion: 0.80,  outputPerMillion: 4.00  },
  'claude-haiku-4-5-20251001':    { inputPerMillion: 0.80,  outputPerMillion: 4.00  },
  'claude-3-5-haiku-20241022':    { inputPerMillion: 0.80,  outputPerMillion: 4.00  },
  // ─── OpenAI ───────────────────────────────────────────────────────────────
  'gpt-4o':                       { inputPerMillion: 2.50,  outputPerMillion: 10.00 },
  'gpt-4o-mini':                  { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
  'gpt-4-turbo':                  { inputPerMillion: 10.00, outputPerMillion: 30.00 },
  'gpt-4.1':                      { inputPerMillion: 2.00,  outputPerMillion: 8.00  },
  'gpt-4.1-mini':                 { inputPerMillion: 0.40,  outputPerMillion: 1.60  },
  'gpt-4.1-nano':                 { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  'gpt-5':                        { inputPerMillion: 10.00, outputPerMillion: 40.00 },
  'gpt-5-mini':                   { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
  'o1':                           { inputPerMillion: 15.00, outputPerMillion: 60.00 },
  'o1-mini':                      { inputPerMillion: 3.00,  outputPerMillion: 12.00 },
  'o3':                           { inputPerMillion: 10.00, outputPerMillion: 40.00 },
  'o3-mini':                      { inputPerMillion: 1.10,  outputPerMillion: 4.40  },
  'o4-mini':                      { inputPerMillion: 1.10,  outputPerMillion: 4.40  },
  // Codex / Copilot models (via GitHub)
  'gpt-5-codex':                  { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.1':                      { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.1-codex':                { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.1-codex-max':            { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.1-codex-mini':           { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.2':                      { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.2-codex':                { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  'gpt-5.3-codex':                { inputPerMillion: 0.00,  outputPerMillion: 0.00  },
  // ─── Gemini ───────────────────────────────────────────────────────────────
  'gemini-2.5-pro':               { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  'gemini-2.5-flash':             { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
  'gemini-2.0-flash':             { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  'gemini-2.0-flash-lite':        { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'gemini-2.0-flash-thinking':    { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
  'gemini-1.5-pro':               { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  'gemini-1.5-flash':             { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'gemini-1.5-flash-8b':          { inputPerMillion: 0.0375,outputPerMillion: 0.15  },
  'gemini-3-pro-preview':         { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  // ─── Qwen / OpenRouter ────────────────────────────────────────────────────
  'qwen/qwen3.7-max':             { inputPerMillion: 1.25,  outputPerMillion: 3.75  },
  'qwen/qwen3.7-plus':            { inputPerMillion: 0.40,  outputPerMillion: 1.60  },
  'qwen/qwen3.6-flash':           { inputPerMillion: 0.1875,outputPerMillion: 1.125 },
  'qwen/qwen3-coder':             { inputPerMillion: 0.22,  outputPerMillion: 1.80  },
  'qwen-max':                     { inputPerMillion: 2.00,  outputPerMillion: 8.00  },
  'qwen-plus':                    { inputPerMillion: 0.50,  outputPerMillion: 2.00  },
  'qwen-turbo':                   { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  'qwen-2.5-72b':                 { inputPerMillion: 0.40,  outputPerMillion: 1.60  },
  'qwen/qwen-2.5-72b-instruct':   { inputPerMillion: 0.40,  outputPerMillion: 1.60  },
  'qwen/qwen-2.5-7b-instruct':    { inputPerMillion: 0.04,  outputPerMillion: 0.12  },
  'qwen/qwq-32b':                 { inputPerMillion: 0.20,  outputPerMillion: 0.60  },
  'qwen/qwen3-235b-a22b':         { inputPerMillion: 0.60,  outputPerMillion: 2.40  },
  'qwen/qwen3-72b':               { inputPerMillion: 0.40,  outputPerMillion: 1.60  },
  'qwen/qwen3-32b':               { inputPerMillion: 0.18,  outputPerMillion: 0.90  },
  'qwen/qwen3-14b':               { inputPerMillion: 0.10,  outputPerMillion: 0.50  },
  'qwen/qwen3-8b':                { inputPerMillion: 0.06,  outputPerMillion: 0.30  },
  // ─── DeepSeek (via OpenRouter / Qwen provider) ────────────────────────────
  'deepseek/deepseek-r1':         { inputPerMillion: 0.55,  outputPerMillion: 2.19  },
  'deepseek/deepseek-chat':       { inputPerMillion: 0.27,  outputPerMillion: 1.10  },
  // ─── Meta Llama (via OpenRouter / Qwen provider) ──────────────────────────
  'meta-llama/llama-3.3-70b-instruct': { inputPerMillion: 0.12, outputPerMillion: 0.12 },
  'meta-llama/llama-4-scout':     { inputPerMillion: 0.17,  outputPerMillion: 0.17  },
  // ─── Mistral (via OpenRouter / Qwen provider) ─────────────────────────────
  'mistral/mistral-large-2411':   { inputPerMillion: 2.00,  outputPerMillion: 6.00  },
  'mistral/mistral-small-3.1':    { inputPerMillion: 0.10,  outputPerMillion: 0.30  },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens  / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.0000';
  if (usd < 0.0001) return `<$0.0001`;
  return `$${usd.toFixed(4)}`;
}

export function getPricing(model: string): ModelPricing | null {
  return MODEL_PRICING[model] ?? null;
}
