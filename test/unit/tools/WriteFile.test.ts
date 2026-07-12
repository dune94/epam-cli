import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WriteFileTool } from '../../../src/tools/builtin/WriteFile.js';

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
