import path from 'path';
import { readJsonFile, writeJsonFile, ensureDir, findAncestorFile } from '../utils/fs.js';
import { ConfigError } from '../utils/errors.js';
import type { ProjectConfig } from './types.js';

const PROJECT_SETTINGS_FILE = '.epam/settings.json';
const PROJECT_CONTEXT_FILE = '.epam/context.md';

export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  const settingsFile = await findAncestorFile(startDir, PROJECT_SETTINGS_FILE);
  if (settingsFile) {
    return path.dirname(path.dirname(settingsFile));
  }
  return null;
}

export async function readProjectConfig(projectRoot: string): Promise<Partial<ProjectConfig>> {
  const settingsPath = path.join(projectRoot, PROJECT_SETTINGS_FILE);
  const data = await readJsonFile<Partial<ProjectConfig>>(settingsPath);
  return data ?? {};
}

export async function writeProjectConfig(
  projectRoot: string,
  config: Partial<ProjectConfig>
): Promise<void> {
  try {
    const settingsDir = path.join(projectRoot, '.epam');
    await ensureDir(settingsDir);
    const settingsPath = path.join(projectRoot, PROJECT_SETTINGS_FILE);
    const existing = await readProjectConfig(projectRoot);
    await writeJsonFile(settingsPath, { ...existing, ...config });
  } catch (err) {
    throw new ConfigError(
      `Failed to write project config: ${(err as Error).message}`,
      err as Error
    );
  }
}

export async function initProjectConfig(projectRoot: string): Promise<void> {
  const epamDir = path.join(projectRoot, '.epam');
  await ensureDir(epamDir);

  const settingsPath = path.join(projectRoot, PROJECT_SETTINGS_FILE);
  const contextPath = path.join(projectRoot, PROJECT_CONTEXT_FILE);

  const { pathExists, writeJsonFile: wjf } = await import('../utils/fs.js');

  if (!(await pathExists(settingsPath))) {
    await writeJsonFile(settingsPath, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextFile: '.epam/context.md',
      maxIterations: 20,
      autoCompressAt: 80000,
    });
  }

  if (!(await pathExists(contextPath))) {
    const fs = await import('fs/promises');
    await fs.writeFile(
      contextPath,
      `# Project Context\n\nDescribe your project here. This is injected into every conversation.\n\n## Key Commands\n\n- \`npm test\` — run tests\n- \`npm run build\` — build project\n`,
      'utf-8'
    );
  }
}

export function getContextFilePath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONTEXT_FILE);
}
