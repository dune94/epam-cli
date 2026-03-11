// ── LLM Prompts for `epam new` project scaffolding ──────────────────────────

import { FIXED_AGENT_ROLES } from './prdTypes.js';

/**
 * Phase A: Analyse the manifest and generate clarifying questions.
 */
export function getManifestAnalysisPrompt(): string {
  return `You are a senior project analyst. You will receive a project manifest written in free-form markdown.

Your job:
1. Summarise the project in 2-3 sentences.
2. Infer a short project name (kebab-case, e.g. "todolist-app").
3. Suggest an uppercase story ID prefix (3-5 chars, e.g. "TODO").
4. Extract the tech stack as a string array.
5. Generate 3-7 clarifying questions that would help generate better user stories. Focus on ambiguities, missing acceptance criteria, unclear scope boundaries, deployment targets, and user personas.

Respond with ONLY valid JSON matching this schema (no markdown fences):
{
  "summary": "<string>",
  "projectName": "<string>",
  "suggestedPrefix": "<string>",
  "techStack": ["<string>"],
  "questions": ["<string>"]
}`;
}

/**
 * Phase B: Propose project-specific agent roles.
 */
export function getAgentProposalPrompt(): string {
  const fixedList = FIXED_AGENT_ROLES.join(', ');
  return `You are a senior engineering manager designing an AI agent team for a software project.

The following ${FIXED_AGENT_ROLES.length} fixed roles are ALWAYS present and must NOT be reproduced:
${fixedList}

Given the project manifest, tech stack, and clarification answers, propose 2-6 project-specific engineering agent roles that will implement the user stories. Each role should map to a distinct domain of the project (e.g. "react-frontend-engineer", "postgres-data-engineer", "auth-security-engineer").

For each role provide:
- name: kebab-case role name ending in "-engineer" or "-specialist"
- systemPrompt: A detailed system prompt (150-300 words) describing the agent's expertise, the project's conventions, key files/directories they own, coding patterns they follow, and tools they use. Be specific to this project.
- rationale: One sentence explaining why this role is needed.

Respond with ONLY valid JSON (no markdown fences):
{
  "proposedAgents": [
    { "name": "<string>", "systemPrompt": "<string>", "rationale": "<string>" }
  ]
}`;
}

/**
 * Phase C: Generate the full prd.json.
 */
export function getPrdGenerationPrompt(prefix: string, agentRoles: string[]): string {
  const roleList = agentRoles.join(', ');
  return `You are a senior product owner and technical architect. Generate a complete PRD (Product Requirements Document) as a JSON object.

STORY ID PREFIX: "${prefix}"
AVAILABLE AGENT ROLES: ${roleList}

Generate a prd.json with:
1. Project metadata (id, title, version "1.0.0", lastUpdated as today's date, project object with name/description/stack)
2. User stories array — each story must have ALL these fields:
   - id: "${prefix}-001", "${prefix}-002", etc.
   - title: concise story title
   - description: detailed description
   - priority: "critical" | "high" | "medium" | "low"
   - status: "pending"
   - completed: false
   - agentGroup: "main" | "primary" | "independent"
   - agentRole: one of the available agent roles
   - acceptanceCriteria: array of 2-5 testable criteria
   - dependencies: array of story IDs this depends on (empty array if none)
   - estimatedHours: number (0.5-8)
   - technicalNotes: { files: string[], requiredSkills: string[] }
   - storyType: "implementation" | "review" | "health_check"
   - effort: "low" | "medium" | "high"
3. implementationOrder: group story IDs into named phases (e.g. "foundation", "core_features", "integration", "polish")
4. phasesConfig: for each phase, set orchestrationMode ("bash"), and a description

Rules:
- Generate 10-30 stories depending on project complexity
- Stories should be ordered by dependency — foundation first, then features, then integration
- Every story must reference a valid agentRole from the available list
- Dependencies must reference valid story IDs
- Keep acceptance criteria specific and testable

Respond with ONLY the valid JSON object (no markdown fences, no commentary).`;
}
