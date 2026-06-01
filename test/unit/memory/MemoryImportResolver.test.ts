import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MemoryImportResolver } from '../../../src/memory/MemoryImportResolver.js';

describe('MemoryImportResolver', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should resolve simple import', async () => {
    const mainFile = path.join(tmpDir, 'main.md');
    const importedFile = path.join(tmpDir, 'imported.md');

    await fs.writeFile(importedFile, 'Imported content', 'utf-8');
    await fs.writeFile(mainFile, 'Main\n@imported.md\nEnd', 'utf-8');

    const resolver = new MemoryImportResolver(mainFile);
    const result = await resolver.resolve(await fs.readFile(mainFile, 'utf-8'));

    expect(result.content).toContain('Imported content');
    expect(result.content).not.toContain('@imported.md');
    expect(result.warnings).toHaveLength(0);
  });

  it('should resolve nested imports', async () => {
    const level1 = path.join(tmpDir, 'level1.md');
    const level2 = path.join(tmpDir, 'level2.md');
    const level3 = path.join(tmpDir, 'level3.md');

    await fs.writeFile(level3, 'Level 3 content', 'utf-8');
    await fs.writeFile(level2, '@level3.md', 'utf-8');
    await fs.writeFile(level1, '@level2.md', 'utf-8');

    const resolver = new MemoryImportResolver(level1);
    const result = await resolver.resolve(await fs.readFile(level1, 'utf-8'));

    expect(result.content).toContain('Level 3 content');
  });

  it('should warn on missing import', async () => {
    const mainFile = path.join(tmpDir, 'main.md');
    await fs.writeFile(mainFile, '@missing.md', 'utf-8');

    const resolver = new MemoryImportResolver(mainFile);
    const result = await resolver.resolve(await fs.readFile(mainFile, 'utf-8'));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Failed to import');
  });

  it('should stop at max depth', async () => {
    const files = ['f1.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md'];

    for (let i = 0; i < files.length - 1; i++) {
      await fs.writeFile(
        path.join(tmpDir, files[i]),
        `@${files[i + 1]}`,
        'utf-8'
      );
    }
    await fs.writeFile(path.join(tmpDir, 'f5.md'), 'Deep content', 'utf-8');

    const resolver = new MemoryImportResolver(path.join(tmpDir, 'f1.md'));
    const result = await resolver.resolve(await fs.readFile(path.join(tmpDir, 'f1.md'), 'utf-8'));

    expect(result.warnings.some(w => w.includes('Import depth exceeded'))).toBe(true);
  });

  it('should handle relative paths', async () => {
    const subdir = path.join(tmpDir, 'subdir');
    await fs.mkdir(subdir);

    const mainFile = path.join(tmpDir, 'main.md');
    const importedFile = path.join(subdir, 'imported.md');

    await fs.writeFile(importedFile, 'Subdir content', 'utf-8');
    await fs.writeFile(mainFile, '@subdir/imported.md', 'utf-8');

    const resolver = new MemoryImportResolver(mainFile);
    const result = await resolver.resolve(await fs.readFile(mainFile, 'utf-8'));

    expect(result.content).toContain('Subdir content');
  });

  it('should detect circular imports', async () => {
    const file1 = path.join(tmpDir, 'file1.md');
    const file2 = path.join(tmpDir, 'file2.md');

    await fs.writeFile(file1, '@file2.md', 'utf-8');
    await fs.writeFile(file2, '@file1.md', 'utf-8');

    const resolver = new MemoryImportResolver(file1);
    const result = await resolver.resolve(await fs.readFile(file1, 'utf-8'));

    expect(result.warnings.some(w => w.includes('Circular import'))).toBe(true);
  });

  it('should preserve non-import lines', async () => {
    const mainFile = path.join(tmpDir, 'main.md');
    const content = '# Header\nRegular line\n@missing.md\nAnother line';
    await fs.writeFile(mainFile, content, 'utf-8');

    const resolver = new MemoryImportResolver(mainFile);
    const result = await resolver.resolve(content);

    expect(result.content).toContain('# Header');
    expect(result.content).toContain('Regular line');
    expect(result.content).toContain('Another line');
  });
});
