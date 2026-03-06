/**
 * DataConfig — runtime-file-driven provider and agent data.
 *
 * Reads from project-local .epam/providers.json and .epam/agents.json,
 * falling back to built-in defaults when the files are absent.
 * Deployments (dev, demo, enterprise) can ship different JSON files to
 * expose only the providers/agents relevant to that environment.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  desc: string;
  price: string;
}

export interface ProviderEntry {
  label: string;
  defaultModel: string;
  models: ModelEntry[];
}

export type ProvidersConfig = Record<string, ProviderEntry>;

// ── Built-in defaults (fallback when no .epam/providers.json exists) ─────────

const BUILTIN_PROVIDERS: ProvidersConfig = {
  claude: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-opus-4-6',            desc: 'Most capable',         price: '$15/$75'    },
      { id: 'claude-opus-4-6-fast',       desc: 'Opus fast mode',       price: '$15/$75'    },
      { id: 'claude-opus-4-5',            desc: 'Previous Opus',        price: '$15/$75'    },
      { id: 'claude-sonnet-4-6',          desc: 'Balanced (default)',   price: '$3/$15'     },
      { id: 'claude-sonnet-4-5',          desc: 'Previous Sonnet',      price: '$3/$15'     },
      { id: 'claude-sonnet-4',            desc: 'Sonnet 4',             price: '$3/$15'     },
      { id: 'claude-3-7-sonnet-20250219', desc: 'Extended thinking',    price: '$3/$15'     },
      { id: 'claude-3-5-sonnet-20241022', desc: 'Claude 3.5 Sonnet',    price: '$3/$15'     },
      { id: 'claude-haiku-4-5',           desc: 'Fast & cheap',         price: '$0.80/$4'   },
      { id: 'claude-haiku-4-5-20251001',  desc: 'Haiku dated',          price: '$0.80/$4'   },
      { id: 'claude-3-5-haiku-20241022',  desc: 'Claude 3.5 Haiku',     price: '$0.80/$4'   },
    ],
  },
  openai: {
    label: 'OpenAI GPT',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o',         desc: 'GPT-4o flagship',       price: '$2.50/$10'  },
      { id: 'gpt-4o-mini',    desc: 'GPT-4o lite',           price: '$0.15/$0.60'},
      { id: 'gpt-4.1',        desc: 'GPT-4.1 (default)',     price: '$2/$8'      },
      { id: 'gpt-4.1-mini',   desc: 'GPT-4.1 mini',         price: '$0.40/$1.60'},
      { id: 'gpt-4.1-nano',   desc: 'GPT-4.1 nano',         price: '$0.10/$0.40'},
      { id: 'gpt-4-turbo',    desc: 'GPT-4 Turbo',          price: '$10/$30'    },
      { id: 'gpt-5',          desc: 'GPT-5 flagship',        price: '$10/$40'    },
      { id: 'gpt-5-mini',     desc: 'GPT-5 mini',           price: '$0.15/$0.60'},
      { id: 'o4-mini',        desc: 'Latest reasoning',      price: '$1.10/$4.40'},
      { id: 'o3',             desc: 'Advanced reasoning',    price: '$10/$40'    },
      { id: 'o3-mini',        desc: 'o3 compact',            price: '$1.10/$4.40'},
      { id: 'o1',             desc: 'Original reasoning',    price: '$15/$60'    },
      { id: 'o1-mini',        desc: 'o1 compact',            price: '$3/$12'     },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-1.5-pro',
    models: [
      { id: 'gemini-2.5-pro',            desc: 'Most capable',     price: '$1.25/$5'    },
      { id: 'gemini-2.5-flash',          desc: 'Fast & cheap',     price: '$0.15/$0.60' },
      { id: 'gemini-2.0-flash',          desc: 'Latest gen',       price: '$0.10/$0.40' },
      { id: 'gemini-2.0-flash-lite',     desc: 'Ultra cheap',      price: '$0.075/$0.30'},
      { id: 'gemini-2.0-flash-thinking', desc: 'With thinking',    price: '$0.15/$0.60' },
      { id: 'gemini-1.5-pro',            desc: 'Proven flagship',  price: '$1.25/$5'    },
      { id: 'gemini-1.5-flash',          desc: 'Fast 1.5',         price: '$0.075/$0.30'},
      { id: 'gemini-1.5-flash-8b',       desc: 'Smallest',         price: '$0.0375/$0.15'},
    ],
  },
  qwen: {
    label: 'Alibaba Qwen',
    defaultModel: 'qwen/qwen-2.5-72b-instruct',
    models: [
      { id: 'qwen/qwen-2.5-72b-instruct',       desc: 'Qwen 2.5 72B (default)',   price: '$0.40/$1.60' },
      { id: 'qwen/qwen-2.5-7b-instruct',        desc: 'Qwen 2.5 7B compact',      price: '$0.04/$0.12' },
      { id: 'qwen/qwq-32b',                     desc: 'QwQ 32B reasoning',         price: '$0.20/$0.60' },
      { id: 'qwen/qwen3-235b-a22b',             desc: 'Qwen3 235B MoE flagship',   price: '$0.60/$2.40' },
      { id: 'qwen/qwen3-72b',                   desc: 'Qwen3 72B',                 price: '$0.40/$1.60' },
      { id: 'qwen/qwen3-32b',                   desc: 'Qwen3 32B',                 price: '$0.18/$0.90' },
      { id: 'qwen/qwen3-14b',                   desc: 'Qwen3 14B',                 price: '$0.10/$0.50' },
      { id: 'qwen/qwen3-8b',                    desc: 'Qwen3 8B',                  price: '$0.06/$0.30' },
      { id: 'deepseek/deepseek-r1',             desc: 'DeepSeek R1 reasoning',     price: '$0.55/$2.19' },
      { id: 'deepseek/deepseek-chat',           desc: 'DeepSeek V3 chat',          price: '$0.27/$1.10' },
      { id: 'meta-llama/llama-3.3-70b-instruct',desc: 'Llama 3.3 70B',            price: '$0.12/$0.12' },
      { id: 'meta-llama/llama-4-scout',         desc: 'Llama 4 Scout',             price: '$0.17/$0.17' },
      { id: 'mistral/mistral-large-2411',       desc: 'Mistral Large',             price: '$2.00/$6.00' },
      { id: 'mistral/mistral-small-3.1',        desc: 'Mistral Small',             price: '$0.10/$0.30' },
    ],
  },
  copilot: {
    label: 'GitHub Copilot (CLI)',
    defaultModel: 'anthropic/claude-4-sonnet',
    models: [
      { id: 'anthropic/claude-4-sonnet',    desc: 'Balanced (default)',   price: 'Included' },
      { id: 'anthropic/claude-4-opus',      desc: 'Most capable',         price: 'Included' },
      { id: 'anthropic/claude-3.7-sonnet',  desc: 'Claude 3.7 Sonnet',    price: 'Included' },
      { id: 'anthropic/claude-3.5-sonnet',  desc: 'Claude 3.5 Sonnet',    price: 'Included' },
      { id: 'anthropic/claude-3.5-haiku',   desc: 'Fast & light',         price: 'Included' },
      { id: 'openai/gpt-5',                 desc: 'GPT-5',                price: 'Included' },
      { id: 'openai/gpt-5-mini',            desc: 'GPT-5 mini',           price: 'Included' },
      { id: 'openai/gpt-4.1',               desc: 'GPT-4.1',              price: 'Included' },
      { id: 'openai/gpt-4o',                desc: 'GPT-4o',               price: 'Included' },
      { id: 'openai/o3-mini',               desc: 'o3-mini reasoning',     price: 'Included' },
      { id: 'google/gemini-2.5-pro',        desc: 'Gemini 2.5 Pro',       price: 'Included' },
      { id: 'google/gemini-2.5-flash',      desc: 'Gemini 2.5 Flash',     price: 'Included' },
      { id: 'xai/grok-4',                   desc: 'Grok 4',               price: 'Included' },
      { id: 'deepseek/deepseek-r1',         desc: 'DeepSeek R1',          price: 'Included' },
      { id: 'meta/llama-4-scout',           desc: 'Llama 4 Scout',        price: 'Included' },
    ],
  },
  codemie: {
    label: 'Codemie (SSO)',
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [
      { id: 'claude-sonnet-4-5-20250929', desc: 'Via EPAM SSO (default)', price: 'Enterprise' },
      { id: 'claude-sonnet-4-6',          desc: 'Latest Sonnet',           price: 'Enterprise' },
      { id: 'claude-opus-4-6',            desc: 'Opus flagship',           price: 'Enterprise' },
      { id: 'gpt-4o',                     desc: 'OpenAI GPT-4o',           price: 'Enterprise' },
      { id: 'gpt-4.1',                    desc: 'OpenAI GPT-4.1',          price: 'Enterprise' },
      { id: 'gemini-2.5-pro',             desc: 'Gemini 2.5 Pro',          price: 'Enterprise' },
    ],
  },
  codex: {
    label: 'OpenAI Codex (CLI)',
    defaultModel: 'gpt-5-codex',
    models: [
      { id: 'gpt-5-codex',   desc: 'Latest (default)',  price: 'Included' },
      { id: 'gpt-5.1-codex', desc: 'GPT-5.1 Codex',    price: 'Included' },
      { id: 'gpt-5.2-codex', desc: 'GPT-5.2 Codex',    price: 'Included' },
      { id: 'o3',            desc: 'Reasoning model',   price: 'Included' },
      { id: 'o4-mini',       desc: 'o4-mini reasoning', price: 'Included' },
    ],
  },
  cursor: {
    label: 'Cursor Agent',
    defaultModel: 'gemini-2.5-pro',
    models: [
      { id: 'gemini-2.5-pro',   desc: 'Most capable (default)', price: '$1.25/$5'    },
      { id: 'gemini-2.5-flash', desc: 'Fast & cheap',           price: '$0.15/$0.60' },
      { id: 'gemini-2.0-flash', desc: 'Latest gen',             price: '$0.10/$0.40' },
    ],
  },
};

const BUILTIN_AGENTS: Record<string, string> = {
  coder:     'You are an expert software engineer. Focus on writing clean, well-typed code with tests. Prefer using file tools to read context before editing. Always explain your changes concisely.',
  reviewer:  'You are a senior code reviewer. Analyse code for bugs, security issues, and style problems. Be direct and specific. Categorise findings as blocker / major / minor. Do not rewrite code unless asked.',
  architect: 'You are a software architect. Focus on high-level design, system structure, and trade-offs. Think in components, interfaces, and data flows. Avoid making direct code edits unless necessary to demonstrate a concept.',
};

// ── Readers ──────────────────────────────────────────────────────────────────

/**
 * Returns provider config merged from .epam/providers.json (if present)
 * over the built-in defaults. Project-local file wins entirely if present.
 */
export function readProviders(): ProvidersConfig {
  const localPath = join(process.cwd(), '.epam', 'providers.json');
  if (!existsSync(localPath)) return BUILTIN_PROVIDERS;
  try {
    const local = JSON.parse(readFileSync(localPath, 'utf-8')) as ProvidersConfig;
    return Object.keys(local).length > 0 ? local : BUILTIN_PROVIDERS;
  } catch {
    return BUILTIN_PROVIDERS;
  }
}

/**
 * Returns built-in agent prompts merged from .epam/agents.json (if present)
 * over the built-in defaults.
 */
export function readBuiltinAgents(): Record<string, string> {
  const localPath = join(process.cwd(), '.epam', 'agents.json');
  if (!existsSync(localPath)) return BUILTIN_AGENTS;
  try {
    const local = JSON.parse(readFileSync(localPath, 'utf-8')) as Record<string, string>;
    return { ...BUILTIN_AGENTS, ...local };
  } catch {
    return BUILTIN_AGENTS;
  }
}
