import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { LLMProvider } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import type { AuditorConfig, AuditorConfigFile } from './types.js';
import { AuditorRunner } from './AuditorRunner.js';
import { logger } from '../utils/logger.js';

/**
 * AuditorRegistry loads and manages auditor personas from .epam/auditors.json
 */
export class AuditorRegistry {
  private static activeRegistry?: AuditorRegistry;
  private auditors: AuditorConfig[] = [];
  private enabled = false;

  constructor(private projectRoot: string) {
    AuditorRegistry.activeRegistry = this;
  }

  static getActive(): AuditorRegistry | undefined {
    return AuditorRegistry.activeRegistry;
  }

  async load(): Promise<void> {
    const configPath = join(this.projectRoot, '.epam', 'auditors.json');

    if (!existsSync(configPath)) {
      logger.debug({ configPath }, 'No auditors.json found — auditors disabled');
      this.auditors = [];
      return;
    }

    try {
      const content = await readFile(configPath, 'utf-8');
      const config = this.parseConfig(JSON.parse(content));

      this.auditors = config.auditors.filter(a => this.isValidAuditor(a));

      logger.debug({ count: this.auditors.length }, 'Loaded auditor personas');
    } catch (error) {
      logger.warn({ error, configPath }, 'Failed to load auditors.json');
      this.auditors = [];
    }
  }

  getAll(): AuditorConfig[] {
    return this.auditors;
  }

  getEnabled(): AuditorConfig[] {
    if (!this.enabled) return [];
    return this.auditors.filter(a => a.enabled !== false);
  }

  getEnabledRunners(provider: LLMProvider, tools: Tool[]): AuditorRunner[] {
    return this.getEnabled().map(auditor => new AuditorRunner(auditor, provider, tools));
  }

  getRunnerByName(
    name: string,
    provider: LLMProvider,
    tools: Tool[],
  ): AuditorRunner | undefined {
    const auditor = this.auditors.find(candidate => candidate.name === name);
    return auditor ? new AuditorRunner(auditor, provider, tools) : undefined;
  }

  toggle(enable: boolean): void {
    this.enabled = enable;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  hasAuditors(): boolean {
    return this.auditors.length > 0;
  }

  private parseConfig(rawConfig: unknown): AuditorConfigFile {
    if (Array.isArray(rawConfig)) {
      return { auditors: rawConfig as AuditorConfig[] };
    }

    if (
      rawConfig &&
      typeof rawConfig === 'object' &&
      Array.isArray((rawConfig as Partial<AuditorConfigFile>).auditors)
    ) {
      return rawConfig as AuditorConfigFile;
    }

    logger.warn('auditors.json must be an array or an object with an "auditors" array');
    return { auditors: [] };
  }

  private isValidAuditor(auditor: AuditorConfig): boolean {
    if (
      !auditor.name ||
      !auditor.persona ||
      !auditor.focus ||
      !auditor.severity_threshold ||
      !auditor.model
    ) {
      logger.warn({ auditor: auditor.name }, 'Invalid auditor config — skipping');
      return false;
    }

    return true;
  }
}
