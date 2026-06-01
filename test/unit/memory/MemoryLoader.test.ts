import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MemoryLoader } from '../../../src/memory/MemoryLoader.js';

describe('MemoryLoader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should load all four memory files when present', async () => {
    const homeDir = os.homedir();
    const globalMemory = path.join(homeDir, '.epam', 'MEMORY.md');
    const projectDir = path.join(tmpDir, '.epam');
    const projectMemory = path.join(projectDir, 'MEMORY.md');
    const localMemory = path.join(projectDir, 'MEMORY.local.md');
    const instructions = path.join(tmpDir, 'INSTRUCTIONS.md');

    // Create directories
    await fs.mkdir(path.join(homeDir, '.epam'), { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });

    // Create files
    await fs.writeFile(globalMemory, '# Global\nGlobal content', 'utf-8');
    await fs.writeFile(projectMemory, '# Project\nProject content', 'utf-8');
    await fs.writeFile(localMemory, '# Local\nLocal content', 'utf-8');
    await fs.writeFile(instructions, '# Instructions\nInstructions content', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory = await loader.load();

    expect(memory.files).toHaveLength(4);
    expect(memory.files[0].label).toBe('GLOBAL MEMORY');
    expect(memory.files[1].label).toBe('PROJECT MEMORY');
    expect(memory.files[2].label).toBe('LOCAL MEMORY');
    expect(memory.files[3].label).toBe('INSTRUCTIONS');

    // Cleanup
    await fs.unlink(globalMemory).catch(() => {});
  });

  it('should silently skip missing files', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    // Only create project memory
    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, '# Project Only', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory = await loader.load();

    expect(memory.files).toHaveLength(1);
    expect(memory.files[0].label).toBe('PROJECT MEMORY');
  });

  it('should warn when file exceeds 200 lines', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    const lines = Array(250).fill('# Line').join('\n');
    await fs.writeFile(projectMemory, lines, 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory = await loader.load();

    expect(memory.warnings).toHaveLength(1);
    expect(memory.warnings[0]).toContain('exceeds 200 lines');
  });

  it('should resolve @import syntax', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    const importedFile = path.join(projectDir, 'imported.md');

    await fs.writeFile(importedFile, 'Imported content', 'utf-8');
    await fs.writeFile(projectMemory, '# Main\n@imported.md\n# End', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory = await loader.load();

    expect(memory.files[0].content).toContain('Imported content');
    expect(memory.files[0].content).not.toContain('@imported.md');
  });

  it('should warn on broken imports', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, '# Main\n@missing.md', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory = await loader.load();

    expect(memory.warnings.length).toBeGreaterThan(0);
    expect(memory.warnings.some(w => w.includes('Failed to import'))).toBe(true);
  });

  it('should prevent circular imports (max 3 hops)', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const file1 = path.join(projectDir, 'file1.md');
    const file2 = path.join(projectDir, 'file2.md');
    const file3 = path.join(projectDir, 'file3.md');
    const file4 = path.join(projectDir, 'file4.md');

    await fs.writeFile(file1, '@file2.md', 'utf-8');
    await fs.writeFile(file2, '@file3.md', 'utf-8');
    await fs.writeFile(file3, '@file4.md', 'utf-8');
    await fs.writeFile(file4, 'Too deep', 'utf-8');

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, '@file1.md', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory = await loader.load();

    // Should have warning about depth exceeded
    expect(memory.warnings.some(w => w.includes('Import depth exceeded'))).toBe(true);
  });

  it('should generate system prompt block with labels', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, 'Project data', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    await loader.load();

    const block = await loader.generateSystemPromptBlock();

    expect(block).toContain('# PROJECT MEMORY');
    expect(block).toContain('Project data');
  });

  it('should calculate total tokens correctly', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    const content = 'a'.repeat(400); // 400 chars = ~100 tokens
    await fs.writeFile(projectMemory, content, 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    await loader.load();

    const tokens = loader.totalTokens();
    expect(tokens).toBe(100);
  });

  it('should reload memory files on reloadAll', async () => {
    const projectDir = path.join(tmpDir, '.epam');
    await fs.mkdir(projectDir, { recursive: true });

    const projectMemory = path.join(projectDir, 'MEMORY.md');
    await fs.writeFile(projectMemory, 'Initial content', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    const memory1 = await loader.load();
    expect(memory1.files[0].content).toBe('Initial content');

    // Modify file
    await fs.writeFile(projectMemory, 'Updated content', 'utf-8');

    // Reload
    const memory2 = await loader.reloadAll();
    expect(memory2.files[0].content).toBe('Updated content');
  });

  it('should return empty string when no memory files exist', async () => {
    const loader = new MemoryLoader(tmpDir);
    await loader.load();

    const block = await loader.generateSystemPromptBlock();
    expect(block).toBe('');
  });

  it('should add .epam/MEMORY.local.md to gitignore', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');

    const loader = new MemoryLoader(tmpDir);
    await loader.ensureLocalMemoryGitignore();

    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.epam/MEMORY.local.md');
  });

  it('should not duplicate entry in gitignore', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, '.epam/MEMORY.local.md\n', 'utf-8');

    const loader = new MemoryLoader(tmpDir);
    await loader.ensureLocalMemoryGitignore();

    const content = await fs.readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const count = lines.filter(l => l.trim() === '.epam/MEMORY.local.md').length;
    expect(count).toBe(1);
  });
});
