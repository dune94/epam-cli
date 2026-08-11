import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WriteFileTool } from '../../../src/tools/builtin/WriteFile.js';

// Wording lives in the project catalog now, not the engine (src/tools/messages.ts). Point at
// the shipped catalog exactly as the runtime invocation does, so these assert the words an
// agent really sees rather than words compiled into the tool.
process.env.EPAM_AGENT_MESSAGE_CATALOG =
  join(__dirname, '../../../orchestrations/config/agent-messages.json');

describe('WriteFileTool', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-file-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes non-JSON files without restriction', async () => {
    const tool = new WriteFileTool();
    const filePath = join(dir, 'notes.txt');
    const result = await tool.execute({ path: filePath, content: 'hello world' });
    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('writes a valid JSON file', async () => {
    const tool = new WriteFileTool();
    const filePath = join(dir, 'prd.json');
    const result = await tool.execute({ path: filePath, content: '{"stories":[]}' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ stories: [] });
  });

  it('refuses to write a .json file with invalid JSON content', async () => {
    const tool = new WriteFileTool();
    const filePath = join(dir, 'prd.json');
    const result = await tool.execute({ path: filePath, content: 'not json at all' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not valid JSON');
  });

  it('refuses an append that would concatenate two JSON documents (the corruption mode seen in production)', async () => {
    const tool = new WriteFileTool();
    const filePath = join(dir, 'prd.json');
    const doc = JSON.stringify({ stories: [{ id: 'SKY-001' }] });
    writeFileSync(filePath, doc, 'utf-8');

    const result = await tool.execute({ path: filePath, content: doc, append: true });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not valid JSON');
    // Critically: the file on disk must be untouched, not left corrupted.
    expect(readFileSync(filePath, 'utf-8')).toBe(doc);
  });

  it('allows an append to a .json file when the merged result is still valid JSON', async () => {
    const tool = new WriteFileTool();
    const filePath = join(dir, 'log.json');
    writeFileSync(filePath, '[1,2', 'utf-8');

    const result = await tool.execute({ path: filePath, content: ',3]', append: true });

    expect(result.isError).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual([1, 2, 3]);
  });
});

describe('WriteFileTool — llm-settings.json settings-guard (2026-08-01)', () => {
  let dir: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-file-settings-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it('blocks a write from any role other than the guardian role', async () => {
    delete process.env.EPAM_AGENT_ROLE;
    process.env.EPAM_AGENT_ROLE = 'typescript-engineer';
    const tool = new WriteFileTool();
    const filePath = join(dir, 'llm-settings.json');
    const result = await tool.execute({ path: filePath, content: '{"maxRetries":7}' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[settings-guard]');
    expect(result.content).toContain('llm-settings-guardian');
  });

  it('blocks a write when EPAM_AGENT_ROLE is unset entirely', async () => {
    delete process.env.EPAM_AGENT_ROLE;
    const tool = new WriteFileTool();
    const filePath = join(dir, 'llm-settings.json');
    const result = await tool.execute({ path: filePath, content: '{}' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[settings-guard]');
  });

  it('allows the write when EPAM_AGENT_ROLE matches the guardian role, and records an audit entry', async () => {
    process.env.EPAM_AGENT_ROLE = 'llm-settings-guardian';
    process.env.EPAM_STORY_ID = 'AMSD-9999';
    const tool = new WriteFileTool();
    const filePath = join(dir, 'llm-settings.json');
    const result = await tool.execute({ path: filePath, content: '{"maxRetries":8}' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ maxRetries: 8 });

    const auditPath = join(dir, 'llm-settings-changes.jsonl');
    const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(auditLines).toHaveLength(1);
    const record = JSON.parse(auditLines[0]);
    expect(record.agentRole).toBe('llm-settings-guardian');
    expect(record.storyId).toBe('AMSD-9999');
    expect(record.previousContent).toBeNull(); // file didn't exist before
    expect(JSON.parse(record.newContent)).toEqual({ maxRetries: 8 });
    expect(typeof record.timestamp).toBe('string');
  });

  it('records the PREVIOUS content on a second change, so a human can see exactly what changed', async () => {
    process.env.EPAM_AGENT_ROLE = 'llm-settings-guardian';
    const tool = new WriteFileTool();
    const filePath = join(dir, 'llm-settings.json');
    await tool.execute({ path: filePath, content: '{"maxRetries":7}' });
    await tool.execute({ path: filePath, content: '{"maxRetries":9}' });

    const auditPath = join(dir, 'llm-settings-changes.jsonl');
    const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(auditLines).toHaveLength(2);
    const second = JSON.parse(auditLines[1]);
    expect(JSON.parse(second.previousContent)).toEqual({ maxRetries: 7 });
    expect(JSON.parse(second.newContent)).toEqual({ maxRetries: 9 });
  });

  it('an overridden guardian role name (EPAM_LLM_SETTINGS_GUARDIAN_ROLE) is respected', async () => {
    process.env.EPAM_LLM_SETTINGS_GUARDIAN_ROLE = 'custom-settings-agent';
    process.env.EPAM_AGENT_ROLE = 'custom-settings-agent';
    const tool = new WriteFileTool();
    const filePath = join(dir, 'llm-settings.json');
    const result = await tool.execute({ path: filePath, content: '{}' });
    expect(result.isError).toBe(false);
  });

  it('does not apply the guard to other .json files, even ones with settings-like names', async () => {
    process.env.EPAM_AGENT_ROLE = 'typescript-engineer';
    const tool = new WriteFileTool();
    const filePath = join(dir, 'other-llm-settings-backup.json');
    const result = await tool.execute({ path: filePath, content: '{}' });
    expect(result.isError).toBe(false);
  });
});
