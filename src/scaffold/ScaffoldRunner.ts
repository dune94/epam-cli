import { promises as fs } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

export interface ScaffoldResult {
  settingsFile: 'created' | 'exists' | 'skipped';
  instructionsFile: 'created' | 'exists' | 'skipped';
}

export interface ScaffoldOptions {
  projectRoot?: string;
  silent?: boolean;
}

export class ScaffoldRunner {
  private projectRoot: string;
  private silent: boolean;

  constructor(options: ScaffoldOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.silent = options.silent ?? false;
  }

  async run(): Promise<ScaffoldResult> {
    const result: ScaffoldResult = {
      settingsFile: 'skipped',
      instructionsFile: 'skipped',
    };

    // Ensure .epam/ directory exists
    const epamDir = join(this.projectRoot, '.epam');
    await this.ensureDirectory(epamDir);

    // Create settings.json if needed
    const settingsPath = join(epamDir, 'settings.json');
    const settingsExists = await this.fileExists(settingsPath);

    if (!settingsExists) {
      await this.createSettingsFile(settingsPath);
      result.settingsFile = 'created';
      if (!this.silent) {
        console.log(chalk.green(`✔ created ${chalk.bold('.epam/settings.json')}`));
      }
    } else {
      result.settingsFile = 'exists';
      if (!this.silent) {
        console.log(chalk.yellow(`⚠ skipped ${chalk.bold('.epam/settings.json')} (already exists)`));
      }
    }

    // Create INSTRUCTIONS.md if needed
    const instructionsPath = join(this.projectRoot, 'INSTRUCTIONS.md');
    const instructionsExists = await this.fileExists(instructionsPath);

    if (!instructionsExists) {
      await this.createInstructionsFile(instructionsPath);
      result.instructionsFile = 'created';
      if (!this.silent) {
        console.log(chalk.green(`✔ created ${chalk.bold('INSTRUCTIONS.md')}`));
      }
    } else {
      result.instructionsFile = 'exists';
      if (!this.silent) {
        console.log(chalk.yellow(`⚠ skipped ${chalk.bold('INSTRUCTIONS.md')} (already exists)`));
      }
    }

    return result;
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      await fs.mkdir(path, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async createSettingsFile(path: string): Promise<void> {
    // In production, templates are bundled adjacent to the dist directory
    // Try multiple locations to support both dev and prod environments
    const possiblePaths = [
      join(process.cwd(), 'src', 'templates', 'settings.default.json'),
      join(process.cwd(), 'dist', '..', 'src', 'templates', 'settings.default.json'),
      join(__dirname, '..', 'templates', 'settings.default.json'),
    ];

    const templateContent = await this.readTemplate(possiblePaths, this.getDefaultSettingsTemplate());
    await fs.writeFile(path, templateContent, 'utf-8');
  }

  private async createInstructionsFile(path: string): Promise<void> {
    const possiblePaths = [
      join(process.cwd(), 'src', 'templates', 'INSTRUCTIONS.default.md'),
      join(process.cwd(), 'dist', '..', 'src', 'templates', 'INSTRUCTIONS.default.md'),
      join(__dirname, '..', 'templates', 'INSTRUCTIONS.default.md'),
    ];

    const templateContent = await this.readTemplate(possiblePaths, this.getDefaultInstructionsTemplate());
    await fs.writeFile(path, templateContent, 'utf-8');
  }

  private async readTemplate(possiblePaths: string[], fallback: string): Promise<string> {
    for (const templatePath of possiblePaths) {
      try {
        return await fs.readFile(templatePath, 'utf-8');
      } catch {
        // Try next path
      }
    }
    // If no template file found, use embedded fallback
    return fallback;
  }

  private getDefaultSettingsTemplate(): string {
    return JSON.stringify({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      defaultModel: 'claude-sonnet-4-6',
      maxIterations: 25,
      autoCompressAt: 100000,
      maxOutputTokens: 16384,
      tools: {
        enabled: ['ReadFile', 'WriteFile', 'Bash', 'ListFiles', 'Search', 'FetchUrl'],
        disabled: [],
        dangerousSkipApproval: false,
      },
      llmChain: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          label: 'primary',
        },
      ],
      budgetGuardrails: {
        warningAt: 1.0,
        hardLimit: 5.0,
        autoDowngrade: false,
      },
    }, null, 2);
  }

  private getDefaultInstructionsTemplate(): string {
    return `# Project Instructions

This file provides context and guidelines for AI assistants working with this project.

## Project Context

<!-- Describe your project: what it does, key technologies, architecture overview -->

**Tech Stack:**
- Language:
- Framework:
- Build tool:
- Testing:

**Key Directories:**
- \`src/\` —
- \`test/\` —
- \`docs/\` —

## Coding Standards

<!-- Define your coding conventions and best practices -->

**Style:**
- Use consistent indentation (tabs/spaces)
- Follow naming conventions
- Add comments for complex logic

**Patterns:**
- Prefer functional programming where appropriate
- Use TypeScript/types for type safety
- Write testable, modular code

**Testing:**
- Write unit tests for new features
- Ensure tests pass before committing
- Aim for meaningful test coverage

## Out of Scope

<!-- Define what the AI should NOT do -->

- Do not modify configuration files without approval
- Do not install new dependencies without discussion
- Do not remove existing tests
- Do not make breaking changes without explicit permission
`;
  }
}
