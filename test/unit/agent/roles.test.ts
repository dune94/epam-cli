import { describe, it, expect } from 'vitest';
import {
  LEADER_ROLE,
  CODER_ROLE,
  TESTER_ROLE,
  SECURITY_AUDITOR_ROLE,
  filterToolsForRole,
} from '../../../src/agent/squad/roles.js';
import type { Tool } from '../../../src/tools/types.js';

const mockTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read file',
    permission: 'safe',
    definition: { name: 'read_file', description: '', inputSchema: { type: 'object', properties: {}, required: [] } },
    execute: async () => ({ toolUseId: '', content: '', isError: false }),
  },
  {
    name: 'write_file',
    description: 'Write file',
    permission: 'review',
    definition: { name: 'write_file', description: '', inputSchema: { type: 'object', properties: {}, required: [] } },
    execute: async () => ({ toolUseId: '', content: '', isError: false }),
  },
  {
    name: 'bash',
    description: 'Execute bash',
    permission: 'dangerous',
    definition: { name: 'bash', description: '', inputSchema: { type: 'object', properties: {}, required: [] } },
    execute: async () => ({ toolUseId: '', content: '', isError: false }),
  },
  {
    name: 'list_files',
    description: 'List files',
    permission: 'safe',
    definition: { name: 'list_files', description: '', inputSchema: { type: 'object', properties: {}, required: [] } },
    execute: async () => ({ toolUseId: '', content: '', isError: false }),
  },
  {
    name: 'search',
    description: 'Search',
    permission: 'safe',
    definition: { name: 'search', description: '', inputSchema: { type: 'object', properties: {}, required: [] } },
    execute: async () => ({ toolUseId: '', content: '', isError: false }),
  },
];

describe('Squad Roles', () => {
  it('LEADER_ROLE has no tools', () => {
    expect(LEADER_ROLE.name).toBe('Leader');
    expect(LEADER_ROLE.allowedToolNames).toEqual([]);
    expect(LEADER_ROLE.systemPrompt).toContain('SquadPlan');
  });

  it('CODER_ROLE has comprehensive tool access', () => {
    expect(CODER_ROLE.name).toBe('Coder');
    expect(CODER_ROLE.allowedToolNames).toContain('read_file');
    expect(CODER_ROLE.allowedToolNames).toContain('write_file');
    expect(CODER_ROLE.allowedToolNames).toContain('bash');
    expect(CODER_ROLE.systemPrompt).toContain('Implement code');
  });

  it('TESTER_ROLE has read-only + bash access', () => {
    expect(TESTER_ROLE.name).toBe('Tester');
    expect(TESTER_ROLE.allowedToolNames).toContain('read_file');
    expect(TESTER_ROLE.allowedToolNames).toContain('bash');
    expect(TESTER_ROLE.allowedToolNames).not.toContain('write_file');
    expect(TESTER_ROLE.systemPrompt).toContain('test scenarios');
  });

  it('SECURITY_AUDITOR_ROLE has read-only access', () => {
    expect(SECURITY_AUDITOR_ROLE.name).toBe('SecurityAuditor');
    expect(SECURITY_AUDITOR_ROLE.allowedToolNames).toContain('read_file');
    expect(SECURITY_AUDITOR_ROLE.allowedToolNames).toContain('search');
    expect(SECURITY_AUDITOR_ROLE.allowedToolNames).not.toContain('write_file');
    expect(SECURITY_AUDITOR_ROLE.allowedToolNames).not.toContain('bash');
    expect(SECURITY_AUDITOR_ROLE.systemPrompt).toContain('security');
  });

  it('filterToolsForRole returns empty for Leader', () => {
    const filtered = filterToolsForRole(LEADER_ROLE, mockTools);
    expect(filtered).toEqual([]);
  });

  it('filterToolsForRole returns correct tools for Coder', () => {
    const filtered = filterToolsForRole(CODER_ROLE, mockTools);
    expect(filtered).toHaveLength(5); // all tools
    expect(filtered.map(t => t.name)).toContain('read_file');
    expect(filtered.map(t => t.name)).toContain('write_file');
    expect(filtered.map(t => t.name)).toContain('bash');
  });

  it('filterToolsForRole returns correct tools for Tester', () => {
    const filtered = filterToolsForRole(TESTER_ROLE, mockTools);
    const names = filtered.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('list_files');
    expect(names).toContain('search');
    expect(names).not.toContain('write_file');
  });

  it('filterToolsForRole returns correct tools for SecurityAuditor', () => {
    const filtered = filterToolsForRole(SECURITY_AUDITOR_ROLE, mockTools);
    const names = filtered.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('list_files');
    expect(names).toContain('search');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('bash');
  });
});
