import path from 'path';
import { getEpamGlobalDir } from '../utils/platform.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/fs.js';
import { ConfigError } from '../utils/errors.js';
import type { GlobalConfig } from './types.js';

const GLOBAL_CONFIG_PATH = path.join(getEpamGlobalDir(), 'config.json');

const DEFAULTS: GlobalConfig = {
  backendUrl: 'https://api.epam.example.com',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  logLevel: 'warn',
  theme: 'auto',
  telemetry: true,
  autoUpdate: true,
};

export async function readGlobalConfig(): Promise<Partial<GlobalConfig>> {
  const data = await readJsonFile<Partial<GlobalConfig>>(GLOBAL_CONFIG_PATH);
  return data ?? {};
}

export async function writeGlobalConfig(config: Partial<GlobalConfig>): Promise<void> {
  try {
    await ensureDir(getEpamGlobalDir());
    const existing = await readGlobalConfig();
    await writeJsonFile(GLOBAL_CONFIG_PATH, { ...existing, ...config });
  } catch (err) {
    throw new ConfigError(`Failed to write global config: ${(err as Error).message}`, err as Error);
  }
}

export function getGlobalConfigDefaults(): GlobalConfig {
  return { ...DEFAULTS };
}

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_PATH;
}
