import { readFileSync } from 'node:fs';
import { templatePath } from '../../prompts/templatesDir';
import { join } from 'node:path';

import type { Tool } from '../../tools/types.js';

/**
 * THE BRIEF IS NOT HERE. Every prompt lives in orchestrations/prompts/templates, and these four
 * sat side by side as template literals — the shape that lets two of them drift apart unnoticed.
 * In the template layer they are diffable against each other.
 *
 * Throws rather than falling back: a squad agent running on an empty brief would look like it was
 * working and follow no instructions at all.
 */
function squadPrompt(id: string): string {
  const file = templatePath(id);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { body?: string };
  if (!doc.body) throw new Error(`[squad] template '${id}' has no body (${file})`);
  return doc.body;
}

export interface AgentRole {
  name: string;
  systemPrompt: string;
  allowedToolNames: string[];
}

export const LEADER_ROLE: AgentRole = {
  name: 'Leader',
  systemPrompt: squadPrompt('squad-leader'),
  allowedToolNames: [],
};

export const CODER_ROLE: AgentRole = {
  name: 'Coder',
  systemPrompt: squadPrompt('squad-coder'),
  allowedToolNames: ['read_file', 'write_file', 'list_files', 'search', 'bash'],
};

export const TESTER_ROLE: AgentRole = {
  name: 'Tester',
  systemPrompt: squadPrompt('squad-tester'),
  allowedToolNames: ['read_file', 'list_files', 'search', 'bash'],
};

export const SECURITY_AUDITOR_ROLE: AgentRole = {
  name: 'SecurityAuditor',
  systemPrompt: squadPrompt('squad-security-auditor'),
  allowedToolNames: ['read_file', 'list_files', 'search'],
};

export const ALL_ROLES: Record<string, AgentRole> = {
  Leader: LEADER_ROLE,
  Coder: CODER_ROLE,
  Tester: TESTER_ROLE,
  SecurityAuditor: SECURITY_AUDITOR_ROLE,
};

export function filterToolsForRole(role: AgentRole, allTools: Tool[]): Tool[] {
  if (role.allowedToolNames.length === 0) {
    return [];
  }
  return allTools.filter(t => role.allowedToolNames.includes(t.name));
}
