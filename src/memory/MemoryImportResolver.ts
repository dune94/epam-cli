import fs from 'fs/promises';
import path from 'path';

const MAX_IMPORT_DEPTH = 3;
const IMPORT_PATTERN = /^@(.+)$/gm;

export interface ResolveResult {
  content: string;
  warnings: string[];
}

/**
 * Resolves @path/to/file import syntax in MEMORY.md files.
 *
 * - Paths are relative to the containing file
 * - Max 3 levels of recursion to prevent circular imports
 * - Broken imports generate startup warnings but don't block loading
 */
export class MemoryImportResolver {
  private containingFile: string;
  private visited: Set<string>;

  constructor(containingFile: string) {
    this.containingFile = containingFile;
    this.visited = new Set<string>();
  }

  async resolve(content: string, depth = 0): Promise<ResolveResult> {
    const warnings: string[] = [];

    if (depth >= MAX_IMPORT_DEPTH) {
      warnings.push(`⚠ Import depth exceeded ${MAX_IMPORT_DEPTH} in ${this.containingFile}`);
      return { content, warnings };
    }

    // Track this file to prevent circular imports
    const normalizedPath = path.resolve(this.containingFile);
    if (this.visited.has(normalizedPath)) {
      warnings.push(`⚠ Circular import detected: ${normalizedPath}`);
      return { content, warnings };
    }
    this.visited.add(normalizedPath);

    // Find all @import lines
    const lines = content.split('\n');
    const resolvedLines: string[] = [];

    for (const line of lines) {
      const match = line.match(/^@(.+)$/);

      if (match) {
        const importPath = match[1].trim();
        const containingDir = path.dirname(this.containingFile);
        const absolutePath = path.resolve(containingDir, importPath);

        try {
          const importedContent = await fs.readFile(absolutePath, 'utf-8');

          // Recursively resolve imports in the imported file
          const resolver = new MemoryImportResolver(absolutePath);
          resolver.visited = new Set(this.visited); // Share visited set
          const result = await resolver.resolve(importedContent, depth + 1);

          warnings.push(...result.warnings);
          resolvedLines.push(result.content);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          warnings.push(`⚠ Failed to import ${importPath} from ${this.containingFile}: ${errorMsg}`);
          // Keep the original @import line as a placeholder
          resolvedLines.push(line);
        }
      } else {
        resolvedLines.push(line);
      }
    }

    return {
      content: resolvedLines.join('\n'),
      warnings,
    };
  }
}
