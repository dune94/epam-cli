import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MemoryImportResolver } from './MemoryImportResolver.js';
import { logger } from '../utils/logger.js';

const LINE_WARNING_THRESHOLD = 200;

export interface MemoryFile {
  path: string;
  label: string;
  content: string;
  lineCount: number;
}

export interface LoadedMemory {
  files: MemoryFile[];
  totalLines: number;
  warnings: string[];
}

/**
 * MemoryLoader discovers and injects MEMORY.md files into the agent system prompt.
 *
 * Load hierarchy (in order):
 * 1. Global: ~/.epam/MEMORY.md
 * 2. Project: .epam/MEMORY.md
 * 3. Local: .epam/MEMORY.local.md (gitignored)
 * 4. Instructions: INSTRUCTIONS.md (backward-compat)
 *
 * Supports @path/to/file import syntax (max 3 levels deep).
 */
export class MemoryLoader {
  private projectRoot: string;
  private cachedMemory: LoadedMemory | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Load all memory files in the hierarchy.
   * Non-existent files are silently skipped.
   */
  async load(): Promise<LoadedMemory> {
    const files: MemoryFile[] = [];
    const warnings: string[] = [];

    const homeDir = os.homedir();
    const epamDir = path.join(this.projectRoot, '.epam');

    const memorySpecs: Array<{ path: string; label: string }> = [
      { path: path.join(homeDir, '.epam', 'MEMORY.md'), label: 'GLOBAL MEMORY' },
      { path: path.join(epamDir, 'MEMORY.md'), label: 'PROJECT MEMORY' },
      { path: path.join(epamDir, 'MEMORY.local.md'), label: 'LOCAL MEMORY' },
      { path: path.join(this.projectRoot, 'INSTRUCTIONS.md'), label: 'INSTRUCTIONS' },
    ];

    for (const spec of memorySpecs) {
      try {
        const exists = await this.fileExists(spec.path);
        if (!exists) continue;

        let content = await fs.readFile(spec.path, 'utf-8');

        // Resolve imports
        const resolver = new MemoryImportResolver(spec.path);
        const resolveResult = await resolver.resolve(content);

        if (resolveResult.warnings.length > 0) {
          warnings.push(...resolveResult.warnings);
        }

        content = resolveResult.content;

        const lineCount = content.split('\n').length;

        // Warn if exceeds line threshold
        if (lineCount > LINE_WARNING_THRESHOLD) {
          const warning = `⚠ ${spec.path} exceeds ${LINE_WARNING_THRESHOLD} lines — consider pruning for best results`;
          warnings.push(warning);
        }

        files.push({
          path: spec.path,
          label: spec.label,
          content,
          lineCount,
        });

        logger.debug({ path: spec.path, label: spec.label, lineCount }, 'Loaded memory file');
      } catch (error) {
        // Silently skip files that can't be read
        logger.debug({ path: spec.path, error }, 'Failed to load memory file');
      }
    }

    const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);

    this.cachedMemory = { files, totalLines, warnings };
    return this.cachedMemory;
  }

  /**
   * Reload all memory files, clearing the cache.
   * Called when /compact runs.
   */
  async reloadAll(): Promise<LoadedMemory> {
    this.cachedMemory = null;
    return await this.load();
  }

  /**
   * Get the currently loaded memory (or load if not cached).
   */
  async getMemory(): Promise<LoadedMemory> {
    if (this.cachedMemory) {
      return this.cachedMemory;
    }
    return await this.load();
  }

  /**
   * Generate the system prompt injection block for all loaded memory files.
   * Each file is injected as a clearly labelled block.
   */
  async generateSystemPromptBlock(): Promise<string> {
    const memory = await this.getMemory();

    if (memory.files.length === 0) {
      return '';
    }

    const blocks = memory.files.map(file => {
      return `# ${file.label}\n\n${file.content}`;
    });

    return blocks.join('\n\n');
  }

  /**
   * Estimate total token count for all loaded memory.
   * Uses simple chars/4 heuristic (same as AgentRunner).
   */
  totalTokens(): number {
    if (!this.cachedMemory) return 0;

    let chars = 0;
    for (const file of this.cachedMemory.files) {
      chars += file.content.length;
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Print startup warnings (line count exceeded, broken imports).
   */
  printWarnings(): void {
    if (!this.cachedMemory || this.cachedMemory.warnings.length === 0) {
      return;
    }

    for (const warning of this.cachedMemory.warnings) {
      console.warn(warning);
    }
  }

  /**
   * Ensure .epam/MEMORY.local.md is in .gitignore when first created.
   */
  async ensureLocalMemoryGitignore(): Promise<void> {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    const entry = '.epam/MEMORY.local.md';

    try {
      let content = '';
      try {
        content = await fs.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist yet
      }

      const lines = content.split('\n');
      const hasEntry = lines.some(line => line.trim() === entry);

      if (!hasEntry) {
        const newContent = content.endsWith('\n') ? content : content + '\n';
        await fs.writeFile(gitignorePath, newContent + entry + '\n', 'utf-8');
        logger.debug('Added .epam/MEMORY.local.md to .gitignore');
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to update .gitignore for MEMORY.local.md');
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
