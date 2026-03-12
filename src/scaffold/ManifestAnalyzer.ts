// ── ManifestAnalyzer — LLM-powered manifest analysis and PRD generation ─────

import type { LLMProvider, ProviderRequest } from '../providers/types.js';
import type { ManifestAnalysis, AgentProposal, PrdSchema } from './prdTypes.js';
import { FIXED_AGENT_ROLES } from './prdTypes.js';
import {
  getManifestAnalysisPrompt,
  getAgentProposalPrompt,
  getPrdGenerationPrompt,
} from './prompts.js';

/**
 * Makes a single LLM completion call and extracts text content.
 */
async function llmCall(
  provider: LLMProvider,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 16384,
): Promise<string> {
  const request: ProviderRequest = {
    messages: [{ role: 'user', content: userMessage }],
    systemPrompt,
    model,
    stream: false,
    maxTokens,
    temperature: 0.4,
  };
  const response = await provider.complete(request);
  const text = response.content
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text!)
    .join('');
  return text.trim();
}

/**
 * Strips markdown code fences from LLM output if present.
 */
function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Phase A: Analyse manifest and produce clarifying questions.
 */
export async function analyzeManifest(
  provider: LLMProvider,
  model: string,
  manifestText: string,
): Promise<ManifestAnalysis> {
  const raw = await llmCall(
    provider,
    model,
    getManifestAnalysisPrompt(),
    `Here is the project manifest:\n\n${manifestText}`,
  );
  return JSON.parse(stripFences(raw)) as ManifestAnalysis;
}

/**
 * Phase B: Propose project-specific agent roles.
 */
export async function proposeAgents(
  provider: LLMProvider,
  model: string,
  manifestText: string,
  qaPairs: Array<{ question: string; answer: string }>,
): Promise<AgentProposal[]> {
  const qaBlock = qaPairs
    .map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`)
    .join('\n\n');

  const userMessage = `Project manifest:\n\n${manifestText}\n\nClarification Q&A:\n\n${qaBlock}`;
  const raw = await llmCall(provider, model, getAgentProposalPrompt(), userMessage);
  const parsed = JSON.parse(stripFences(raw)) as { proposedAgents: AgentProposal[] };
  return parsed.proposedAgents;
}

/**
 * Phase C: Generate complete prd.json from all collected context.
 */
export async function generatePrd(
  provider: LLMProvider,
  model: string,
  manifestText: string,
  qaPairs: Array<{ question: string; answer: string }>,
  confirmedAgentRoles: string[],
  prefix: string,
): Promise<PrdSchema> {
  const allRoles = [...FIXED_AGENT_ROLES, ...confirmedAgentRoles];
  const qaBlock = qaPairs
    .map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`)
    .join('\n\n');

  const userMessage = [
    `Project manifest:\n\n${manifestText}`,
    `\nClarification Q&A:\n\n${qaBlock}`,
    `\nGenerate the complete prd.json now.`,
  ].join('\n');

  const raw = await llmCall(
    provider,
    model,
    getPrdGenerationPrompt(prefix, allRoles),
    userMessage,
  );
  const parsed = JSON.parse(stripFences(raw));

  // Normalize: LLM may use "userStories" instead of "stories"
  if (!parsed.stories && parsed.userStories) {
    parsed.stories = parsed.userStories;
    delete parsed.userStories;
  }

  return parsed as PrdSchema;
}
