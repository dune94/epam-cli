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

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function extractJsonCandidate(text: string): string | null {
  const stripped = stripFences(text);
  if (!stripped) return null;
  if (tryParseJson(stripped) !== null) return stripped;

  const jsonFence = stripped.match(/```json\s*([\s\S]*?)```/i) ?? stripped.match(/```\s*([\s\S]*?)```/i);
  if (jsonFence?.[1]) {
    const fenced = jsonFence[1].trim();
    if (tryParseJson(fenced) !== null) return fenced;
  }

  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const objectSlice = stripped.slice(firstBrace, lastBrace + 1);
    if (tryParseJson(objectSlice) !== null) return objectSlice;
  }

  const firstBracket = stripped.indexOf('[');
  const lastBracket = stripped.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const arraySlice = stripped.slice(firstBracket, lastBracket + 1);
    if (tryParseJson(arraySlice) !== null) return arraySlice;
  }

  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isManifestAnalysis(value: unknown): value is ManifestAnalysis {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.summary === 'string' &&
    typeof candidate.projectName === 'string' &&
    typeof candidate.suggestedPrefix === 'string' &&
    isStringArray(candidate.techStack) &&
    isStringArray(candidate.questions)
  );
}

function isAgentProposal(value: unknown): value is AgentProposal {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.systemPrompt === 'string' &&
    typeof candidate.rationale === 'string'
  );
}

function hasAgentProposalShape(value: unknown): value is { proposedAgents: AgentProposal[] } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.proposedAgents) && candidate.proposedAgents.every(isAgentProposal);
}

function hasPrdShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const stories = candidate.stories ?? candidate.userStories;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.lastUpdated === 'string' &&
    Array.isArray(stories) &&
    !!candidate.implementationOrder &&
    typeof candidate.implementationOrder === 'object' &&
    !!candidate.phasesConfig &&
    typeof candidate.phasesConfig === 'object'
  );
}

function normalizePrdShape(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const candidate = { ...(value as Record<string, unknown>) };

  const metadata =
    (candidate.projectMetadata && typeof candidate.projectMetadata === 'object' ? candidate.projectMetadata : null) ??
    (candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : null) ??
    (candidate.projectInfo && typeof candidate.projectInfo === 'object' ? candidate.projectInfo : null);

  if (metadata) {
    const meta = metadata as Record<string, unknown>;
    candidate.id ??= meta.id;
    candidate.title ??= meta.title;
    candidate.version ??= meta.version;
    candidate.lastUpdated ??= meta.lastUpdated;
    candidate.project ??= meta.project;
  }

  candidate.stories ??= candidate.userStories;
  candidate.project ??= candidate.projectDetails;
  candidate.implementationOrder ??= candidate.phaseOrder;
  candidate.phasesConfig ??= candidate.phaseConfigurations;

  return candidate;
}

async function parseStructuredResponse<T>(
  provider: LLMProvider,
  model: string,
  raw: string,
  schemaPrompt: string,
  phaseName: string,
  validate: (value: unknown) => value is T,
  normalize?: (value: unknown) => unknown,
): Promise<T> {
  const candidate = extractJsonCandidate(raw);
  if (candidate) {
    const parsed = normalize ? normalize(JSON.parse(candidate) as unknown) : JSON.parse(candidate) as unknown;
    if (validate(parsed)) {
      return parsed;
    }
  }

  const repaired = await llmCall(
    provider,
    model,
    [
      'You convert assistant output into strict JSON.',
      'Return ONLY valid JSON. No prose. No markdown fences.',
      `Match this schema exactly:\n${schemaPrompt}`,
    ].join('\n\n'),
    `Convert this response into valid JSON:\n\n${raw}`,
    16384,
  );

  const repairedCandidate = extractJsonCandidate(repaired);
  if (repairedCandidate) {
    const repairedParsed = normalize
      ? normalize(JSON.parse(repairedCandidate) as unknown)
      : JSON.parse(repairedCandidate) as unknown;
    if (validate(repairedParsed)) {
      return repairedParsed;
    }
  }

  throw new Error(
    `${phaseName} failed to produce valid JSON. Raw output preview: ${raw.slice(0, 200)}`,
  );
}

/**
 * Phase A: Analyse manifest and produce clarifying questions.
 */
export async function analyzeManifest(
  provider: LLMProvider,
  model: string,
  manifestText: string,
): Promise<ManifestAnalysis> {
  const schemaPrompt = `{
  "summary": "<string>",
  "projectName": "<string>",
  "suggestedPrefix": "<string>",
  "techStack": ["<string>"],
  "questions": ["<string>"]
}`;
  const raw = await llmCall(
    provider,
    model,
    getManifestAnalysisPrompt(),
    `Here is the project manifest:\n\n${manifestText}`,
  );
  return parseStructuredResponse<ManifestAnalysis>(
    provider,
    model,
    raw,
    schemaPrompt,
    'Manifest analysis',
    isManifestAnalysis,
  );
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
  const schemaPrompt = `{
  "proposedAgents": [
    { "name": "<string>", "systemPrompt": "<string>", "rationale": "<string>" }
  ]
}`;
  const qaBlock = qaPairs
    .map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`)
    .join('\n\n');

  const userMessage = `Project manifest:\n\n${manifestText}\n\nClarification Q&A:\n\n${qaBlock}`;
  const raw = await llmCall(provider, model, getAgentProposalPrompt(), userMessage);
  const parsed = await parseStructuredResponse<{ proposedAgents: AgentProposal[] }>(
    provider,
    model,
    raw,
    schemaPrompt,
    'Agent proposal',
    hasAgentProposalShape,
  );
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
  const parsed = await parseStructuredResponse<Record<string, unknown>>(
    provider,
    model,
    raw,
    getPrdGenerationPrompt(prefix, allRoles),
    'PRD generation',
    hasPrdShape,
    normalizePrdShape,
  );

  // Normalize: LLM may use "userStories" instead of "stories"
  if (!parsed.stories && parsed.userStories) {
    parsed.stories = parsed.userStories;
    delete parsed.userStories;
  }

  return parsed as unknown as PrdSchema;
}
