// ── GitIngest — TypeScript wrapper for codebase-to-LLM-context extraction ───
//
// Shells out to the `gitingest` Python CLI to produce a prompt-friendly
// text digest of a repository or subdirectory.  Used by the documentation
// orchestration pipeline to give doc-generating agents full codebase context.
//
// Requires: pip install gitingest

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface GitIngestResult {
  /** Full digest text (tree + file contents) */
  content: string;
  /** Estimated token count (from gitingest) */
  estimatedTokens: number;
  /** Number of files included */
  fileCount: number;
  /** Path or URL that was ingested */
  source: string;
}

export interface GitIngestOptions {
  /** Path to local directory or GitHub URL */
  source: string;
  /** Output file path (if omitted, captures stdout) */
  outputPath?: string;
  /** Include patterns (glob) */
  include?: string[];
  /** Exclude patterns (glob) */
  exclude?: string[];
  /** Include .gitignored files */
  includeGitignored?: boolean;
  /** Include git submodules */
  includeSubmodules?: boolean;
  /** Max file size in bytes to include (skip larger files) */
  maxFileSize?: number;
}

/**
 * Check whether the gitingest CLI is available.
 */
export async function isGitIngestAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gitingest', ['--help'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ingest a local directory or GitHub repo into LLM-friendly text.
 */
export async function ingest(options: GitIngestOptions): Promise<GitIngestResult> {
  const args: string[] = [options.source];

  if (options.outputPath) {
    args.push('--output', options.outputPath);
  }

  if (options.includeGitignored) {
    args.push('--include-gitignored');
  }

  if (options.includeSubmodules) {
    args.push('--include-submodules');
  }

  logger.debug({ source: options.source, args }, 'GitIngest: running');

  try {
    const { stdout, stderr } = await execFileAsync('gitingest', args, {
      timeout: 120_000, // 2 minute timeout for large repos
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });

    if (stderr) {
      logger.debug({ stderr: stderr.slice(0, 500) }, 'GitIngest stderr');
    }

    // If output was written to file, read it back
    let content: string;
    if (options.outputPath) {
      content = await fs.readFile(options.outputPath, 'utf-8');
    } else {
      content = stdout;
    }

    // Parse stats from the content
    const tokenMatch = content.match(/Estimated tokens:\s*([\d,]+)/i);
    const fileMatch = content.match(/Files included:\s*(\d+)/i) ??
                      content.match(/(\d+)\s+files?\s+analyzed/i);

    const estimatedTokens = tokenMatch
      ? parseInt(tokenMatch[1].replace(/,/g, ''), 10)
      : Math.ceil(content.length / 4); // rough estimate

    const fileCount = fileMatch
      ? parseInt(fileMatch[1], 10)
      : content.split('\n').filter(l => l.startsWith('File: ') || l.startsWith('--- ')).length;

    logger.debug({
      source: options.source,
      contentLength: content.length,
      estimatedTokens,
      fileCount,
    }, 'GitIngest: complete');

    return {
      content,
      estimatedTokens,
      fileCount,
      source: options.source,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: message, source: options.source }, 'GitIngest: failed');
    throw new Error(`GitIngest failed for ${options.source}: ${message}`);
  }
}

/**
 * Ingest only specific subdirectories of a project.
 * Useful for scoping documentation to changed modules.
 */
export async function ingestSubdirectories(
  projectRoot: string,
  subdirs: string[],
  options?: Omit<GitIngestOptions, 'source'>,
): Promise<GitIngestResult[]> {
  const results: GitIngestResult[] = [];

  for (const subdir of subdirs) {
    const fullPath = `${projectRoot}/${subdir}`;
    if (!existsSync(fullPath)) {
      logger.debug({ path: fullPath }, 'GitIngest: skipping non-existent subdirectory');
      continue;
    }

    const result = await ingest({ ...options, source: fullPath });
    results.push(result);
  }

  return results;
}

/**
 * Ingest only files that changed in the current git diff.
 * Useful for documentation updates scoped to recent code changes.
 */
export async function ingestChangedFiles(
  projectRoot: string,
  baseBranch: string = 'main',
): Promise<GitIngestResult> {
  // Get changed files from git
  const { stdout: diffOutput } = await execFileAsync(
    'git',
    ['diff', '--name-only', baseBranch, 'HEAD'],
    { cwd: projectRoot, timeout: 10_000 },
  );

  const changedFiles = diffOutput.trim().split('\n').filter(Boolean);

  if (changedFiles.length === 0) {
    return {
      content: '(no changed files)',
      estimatedTokens: 0,
      fileCount: 0,
      source: projectRoot,
    };
  }

  // Read each changed file and concatenate
  const parts: string[] = [`# Changed files (${changedFiles.length}) since ${baseBranch}\n`];

  for (const file of changedFiles) {
    const fullPath = `${projectRoot}/${file}`;
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      parts.push(`\n--- ${file} ---\n${content}\n`);
    } catch {
      parts.push(`\n--- ${file} --- (deleted or unreadable)\n`);
    }
  }

  const content = parts.join('');
  return {
    content,
    estimatedTokens: Math.ceil(content.length / 4),
    fileCount: changedFiles.length,
    source: projectRoot,
  };
}
