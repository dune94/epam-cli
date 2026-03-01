import type { Message } from '../providers/types.js';

export type SeverityLevel = 'info' | 'warning' | 'critical';

export const SEVERITY_RANK: Record<SeverityLevel, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

export interface AuditorConfig {
  name: string;
  persona: string;
  focus: string;
  severity_threshold: SeverityLevel;
  model: string;
  enabled?: boolean;
}

export interface AuditorFinding {
  auditorName: string;
  severity: SeverityLevel;
  finding: string;
}

export interface AuditorResult {
  auditorName: string;
  findings: AuditorFinding[];
  /** Full transcript of the auditor's critique */
  transcript: string;
  severity: SeverityLevel;
}

export interface AuditorInput {
  /** The user's original message */
  userMessage: string;
  /** The agent's proposed response */
  proposedResponse: string;
  /** Full conversation context */
  conversationHistory: Message[];
}

export interface AuditorConfigFile {
  auditors: AuditorConfig[];
}

export interface AuditorGateDecision {
  blocked: boolean;
  blockingAuditors: AuditorResult[];
}
