export interface ModelPricing {
  inputPerMillion: number;  // USD per 1M input tokens
  outputPerMillion: number; // USD per 1M output tokens
}

// Prices as of early 2026 — update as providers change
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-6':           { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'claude-sonnet-4-6':         { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.80,  outputPerMillion: 4.00  },
  // OpenAI
  'gpt-4o':                    { inputPerMillion: 2.50,  outputPerMillion: 10.00 },
  'gpt-4o-mini':               { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
  // Gemini
  'gemini-1.5-pro':            { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  'gemini-1.5-flash':          { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'gemini-2.0-flash':          { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  // Qwen (Alibaba Cloud DashScope)
  'qwen-max':                  { inputPerMillion: 2.00,  outputPerMillion: 8.00  },
  'qwen-plus':                 { inputPerMillion: 0.50,  outputPerMillion: 2.00  },
  'qwen-turbo':                { inputPerMillion: 0.10,  outputPerMillion: 0.40  },
  'qwen-2.5-72b':              { inputPerMillion: 0.40,  outputPerMillion: 1.60  },
  // Cursor (Gemini API)
  'gemini-2.5-pro':            { inputPerMillion: 1.25,  outputPerMillion: 5.00  },
  // GitHub Copilot uses Claude API (pricing already defined above)
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
