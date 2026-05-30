// ── PRD Schema Types ─────────────────────────────────────────────────────────
// Mirrors the structure of orchestrations/prd.json

export interface PrdStory {
  id: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'backlog';
  completed: boolean;
  agentGroup: string;
  agentRole: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  estimatedHours: number;
  technicalNotes: {
    files: string[];
    requiredSkills: string[];
  };
  storyType: 'implementation' | 'review' | 'health_check' | 'infrastructure';
  aiProvider?: string;
  estimatedCost?: number;
  estimatedTokens?: number;
  estimatedTurns?: number;
  humanHours?: number;
  effort?: 'low' | 'medium' | 'high';
  cpaConfidence?: number;
  cpaGate?: 'pass' | 'review' | 'escalate';
}

export interface PhaseConfig {
  orchestrationMode: 'bash' | 'hybrid';
  aiProvider?: string;
  defaultModel?: string;
  description?: string;
}

export interface PrdProject {
  name: string;
  description: string;
  stack: {
    language: string;
    runtime: string;
    bundler?: string;
    testing?: string;
    devEnvironment?: string;
  };
}

export interface PrdSchema {
  id: string;
  title: string;
  version: string;
  lastUpdated: string;
  project: PrdProject;
  stories: PrdStory[];
  implementationOrder: Record<string, string[]>;
  phasesConfig: Record<string, PhaseConfig>;
  totalEstimatedHours?: number;
  currentIteration?: number;
}

// ── Agent Types ──────────────────────────────────────────────────────────────

export interface AgentProposal {
  name: string;
  systemPrompt: string;
  rationale: string;
}

export interface ManifestAnalysis {
  summary: string;
  projectName: string;
  suggestedPrefix: string;
  techStack: string[];
  questions: string[];
}

// ── Fixed agent roles (always scaffolded) ────────────────────────────────────

export const FIXED_AGENT_ROLES = [
  'spec-coordinator-agent',
  'openspec-agent',
  'speckit-agent',
  'team-lead-agent',
  'review-agent',
  'test-coordinator-agent',
  'sast-sentinel',
  'spec-validator',
  'review-ranger',
  'mutant-hunter',
  'fuzz-weaver',
  'perf-sentinel',
  'hygiene-sentinel',
  'design-sentinel',
  'pattern-sentinel',
  'project-initiator-agent',
  'prd-project-manager-agent',
  'agent-skills-agent',
  'dashboard-orchestrator-agent',
  'dashboard-test-agent',
  'dashboard-update-agent',
] as const;
