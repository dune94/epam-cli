// ── ProjectScaffolder — writes a complete orchestration workspace ─────────────

import { promises as fs } from 'fs';
import { join, resolve, dirname } from 'path';
import chalk from 'chalk';
import type { PrdSchema, AgentProposal } from './prdTypes.js';
import { FIXED_AGENT_ROLES } from './prdTypes.js';
import { MANAGED_DASHBOARD_FILES } from './DashboardHydrator.js';

export interface ProjectScaffoldOptions {
  targetPath: string;
  prd: PrdSchema;
  projectAgents: AgentProposal[];
  projectName: string;
  techStack: string[];
  summary: string;
  silent?: boolean;
}

export interface ProjectScaffoldResult {
  filesCreated: string[];
  filesSkipped: string[];
  dirsCreated: string[];
}

export class ProjectScaffolder {
  private target: string;
  private opts: ProjectScaffoldOptions;
  private result: ProjectScaffoldResult = {
    filesCreated: [],
    filesSkipped: [],
    dirsCreated: [],
  };

  constructor(opts: ProjectScaffoldOptions) {
    this.target = resolve(opts.targetPath);
    this.opts = opts;
  }

  async scaffold(): Promise<ProjectScaffoldResult> {
    // Step 1: Create directory structure
    await this.createDirectories();

    // Step 2: Write prd.json
    await this.writePrd();

    // Step 3: Write merged profiles.json
    await this.writeProfiles();

    // Step 4: Write KB.md skeleton
    await this.writeKnowledgeBase();

    // Step 5: Write AGENTS.md (empty)
    await this.writeFile(
      join(this.target, 'orchestrations', 'agents', 'AGENTS.md'),
      '# Learned Patterns\n\nAppended automatically during orchestration runs.\n',
    );

    // Step 6: Write .epam/settings.json
    await this.writeSettings();

    // Step 7: Write INSTRUCTIONS.md
    await this.writeInstructions();

    // Step 8: Copy orchestration scripts
    await this.copyOrchestrationScripts();

    // Step 9: Copy dashboards
    await this.copyDashboards();

    // Step 10: Create dashboard symlinks
    await this.createDashboardSymlinks();

    // Step 11: Write orchestrations/README.md
    await this.writeOrchestrationReadme();

    return this.result;
  }

  // ── Directory structure ──────────────────────────────────────────────────

  private async createDirectories(): Promise<void> {
    const dirs = [
      'orchestrations',
      'orchestrations/agents',
      'orchestrations/scripts',
      'orchestrations/scripts/lib',
      'orchestrations/dashboards',
      'orchestrations/logs',
      '.epam',
    ];
    for (const dir of dirs) {
      const full = join(this.target, dir);
      await this.ensureDir(full);
    }
  }

  // ── prd.json ─────────────────────────────────────────────────────────────

  private async writePrd(): Promise<void> {
    const path = join(this.target, 'orchestrations', 'prd.json');
    await this.writeFile(path, JSON.stringify(this.opts.prd, null, 2));
  }

  // ── profiles.json (fixed + project-specific agents) ──────────────────────

  private async writeProfiles(): Promise<void> {
    const path = join(this.target, 'orchestrations', 'agents', 'profiles.json');

    // Load fixed agent prompts from the epam-cli source
    const fixedProfiles = await this.loadFixedProfiles();

    // Merge with project-specific agents
    const profiles: Record<string, string> = { ...fixedProfiles };
    for (const agent of this.opts.projectAgents) {
      profiles[agent.name] = agent.systemPrompt;
    }

    await this.writeFile(path, JSON.stringify(profiles, null, 2));
  }

  private async loadFixedProfiles(): Promise<Record<string, string>> {
    // Try to read from the epam-cli installation
    const possiblePaths = [
      join(process.cwd(), 'orchestrations', 'agents', 'profiles.json'),
      join(dirname(dirname(__dirname)), 'orchestrations', 'agents', 'profiles.json'),
    ];

    for (const p of possiblePaths) {
      try {
        const raw = await fs.readFile(p, 'utf-8');
        const all = JSON.parse(raw) as Record<string, string>;
        // Filter to only fixed roles
        const fixed: Record<string, string> = {};
        for (const role of FIXED_AGENT_ROLES) {
          if (all[role]) fixed[role] = all[role];
        }
        return fixed;
      } catch { /* try next */ }
    }

    // Fallback: return minimal stubs
    const stubs: Record<string, string> = {};
    for (const role of FIXED_AGENT_ROLES) {
      stubs[role] = `You are the ${role} for this project.`;
    }
    return stubs;
  }

  // ── KB.md ────────────────────────────────────────────────────────────────

  private async writeKnowledgeBase(): Promise<void> {
    const path = join(this.target, 'orchestrations', 'agents', 'KB.md');
    const { projectName, techStack, summary } = this.opts;

    const content = `# Shared Knowledge Base

Shared context available to all agents during orchestrated execution.

## Project: ${projectName}

${summary}

- **Tech Stack**: ${techStack.join(', ')}

## Key Paths

| Path | Purpose |
|------|---------|
| \`orchestrations/prd.json\` | Master PRD with all user stories |
| \`orchestrations/agents/profiles.json\` | Agent role definitions |
| \`orchestrations/scripts/\` | Orchestration engine scripts |
| \`orchestrations/dashboards/\` | Live dashboards (Eleventy) |
| \`orchestrations/logs/\` | Runtime logs and metrics |
| \`.epam/settings.json\` | Project configuration |

## Conventions

- All orchestration artifacts live under \`orchestrations/\`
- Agent roles are defined in \`profiles.json\` and assigned to stories in \`prd.json\`
- Use \`/orchestrate spec <phase>\` to elaborate specifications before execution
- Use \`/orchestrate estimate <phase>\` for cost pre-assessment
- Use \`/orchestrate execution <phase>\` to launch implementation
`;
    await this.writeFile(path, content);
  }

  // ── .epam/settings.json ──────────────────────────────────────────────────

  private async writeSettings(): Promise<void> {
    const path = join(this.target, '.epam', 'settings.json');
    const settings = {
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
        { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'primary' },
      ],
      budgetGuardrails: {
        warningAt: 1.0,
        hardLimitAt: 5.0,
        autoDowngrade: false,
      },
    };
    await this.writeFile(path, JSON.stringify(settings, null, 2));
  }

  // ── INSTRUCTIONS.md ──────────────────────────────────────────────────────

  private async writeInstructions(): Promise<void> {
    const path = join(this.target, 'INSTRUCTIONS.md');
    const { projectName, techStack, summary } = this.opts;

    const content = `# Project Instructions

## Project Context

**${projectName}** — ${summary}

**Tech Stack:** ${techStack.join(', ')}

## Orchestration

This project uses epam-cli's multi-agent orchestration system.

- PRD: \`orchestrations/prd.json\`
- Agent profiles: \`orchestrations/agents/profiles.json\`
- Dashboards: \`orchestrations/dashboards/\` (serve with Eleventy)

### Workflow

1. \`/orchestrate spec <phase>\` — Elaborate specifications (openspec + speckit)
2. \`/orchestrate estimate <phase>\` — Cost pre-assessment
3. \`/orchestrate execution <phase>\` — Launch implementation agents
4. \`/orchestrate status\` — Monitor progress

## Out of Scope

- Do not modify orchestration scripts without explicit approval
- Do not commit API keys or credentials
- Do not remove existing tests
`;
    await this.writeFile(path, content);
  }

  // ── Copy orchestration scripts ───────────────────────────────────────────

  private async copyOrchestrationScripts(): Promise<void> {
    const sourceDir = await this.findSourceDir('orchestrations/scripts');
    if (!sourceDir) {
      this.log(chalk.yellow('  Skipping scripts copy — source not found'));
      return;
    }

    await this.copyDirRecursive(
      sourceDir,
      join(this.target, 'orchestrations', 'scripts'),
    );
  }

  // ── Copy dashboards ─────────────────────────────────────────────────────

  private async copyDashboards(): Promise<void> {
    const sourceDir = await this.findSourceDir('orchestrations/dashboards');
    if (!sourceDir) {
      this.log(chalk.yellow('  Skipping dashboards copy — source not found'));
      return;
    }

    const targetDir = join(this.target, 'orchestrations', 'dashboards');

    // Managed dashboards + eleventy config
    const priorityFiles = [
      ...MANAGED_DASHBOARD_FILES,
      '.eleventy.js',
    ];

    for (const file of priorityFiles) {
      const src = join(sourceDir, file);
      const dest = join(targetDir, file);
      try {
        await fs.access(src);
        await fs.copyFile(src, dest);
        this.result.filesCreated.push(dest);
      } catch { /* file doesn't exist in source, skip */ }
    }

    // Copy demo markdown files if present
    try {
      const entries = await fs.readdir(sourceDir);
      for (const entry of entries) {
        if (entry.startsWith('demo-') && entry.endsWith('.md')) {
          const src = join(sourceDir, entry);
          const dest = join(targetDir, entry);
          await fs.copyFile(src, dest);
          this.result.filesCreated.push(dest);
        }
      }
    } catch { /* ignore */ }

    // Create package.json for Eleventy dependency
    const pkgPath = join(targetDir, 'package.json');
    try {
      await fs.access(pkgPath);
      // Already exists — skip
    } catch {
      const pkg = JSON.stringify({
        name: 'epam-dashboards',
        private: true,
        scripts: { serve: 'eleventy --serve', build: 'eleventy' },
        dependencies: { '@11ty/eleventy': '^2.0.1' },
      }, null, 2);
      await fs.writeFile(pkgPath, pkg, 'utf-8');
      this.result.filesCreated.push(pkgPath);
    }
  }

  // ── Dashboard symlinks ──────────────────────────────────────────────────

  private async createDashboardSymlinks(): Promise<void> {
    const dashDir = join(this.target, 'orchestrations', 'dashboards');

    const links: Array<[string, string]> = [
      ['prd.json', '../prd.json'],
      ['profiles.json', '../agents/profiles.json'],
      ['logs', '../logs'],
    ];

    for (const [name, target] of links) {
      const linkPath = join(dashDir, name);
      try {
        await fs.access(linkPath);
        // Already exists
      } catch {
        try {
          await fs.symlink(target, linkPath);
          this.result.filesCreated.push(linkPath);
        } catch { /* ignore symlink failures */ }
      }
    }
  }

  // ── Orchestrations README ───────────────────────────────────────────────

  private async writeOrchestrationReadme(): Promise<void> {
    const path = join(this.target, 'orchestrations', 'README.md');
    const content = `# Orchestration

This directory contains the multi-agent orchestration workspace for **${this.opts.projectName}**.

## Structure

- \`prd.json\` — Product Requirements Document (stories, phases, agent assignments)
- \`agents/\` — Agent profiles and shared knowledge base
- \`scripts/\` — Orchestration engine (bash + node runners)
- \`dashboards/\` — Live HTML dashboards (Eleventy)
- \`logs/\` — Runtime execution logs

## Quick Start

\`\`\`bash
# Elaborate specifications
epam orchestrate --phase foundation

# Install dashboard dependencies (first time only)
cd orchestrations/dashboards && npm install && cd ../..

# Serve dashboards (run from project root)
npx --prefix orchestrations/dashboards eleventy --config=orchestrations/dashboards/.eleventy.js --serve
\`\`\`
`;
    await this.writeFile(path, content);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async findSourceDir(relative: string): Promise<string | null> {
    const candidates = [
      join(process.cwd(), relative),
      join(dirname(dirname(__dirname)), relative),
    ];
    for (const p of candidates) {
      try {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) return p;
      } catch { /* next */ }
    }
    return null;
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await this.ensureDir(dest);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        // Skip log output dirs, test dirs, and node_modules
        if (['node_modules', '__pycache__', 'test'].includes(entry.name)) continue;
        await this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        // Skip log files and backups
        if (entry.name.endsWith('.log') || entry.name.endsWith('.backup')) continue;
        await fs.copyFile(srcPath, destPath);
        this.result.filesCreated.push(destPath);
      }
    }
  }

  private async ensureDir(path: string): Promise<void> {
    try {
      await fs.mkdir(path, { recursive: true });
      this.result.dirsCreated.push(path);
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    try {
      await fs.access(path);
      // File exists — skip unless it's prd.json (always overwrite on regeneration)
      if (!path.endsWith('prd.json')) {
        this.result.filesSkipped.push(path);
        this.log(chalk.yellow(`  skip ${this.rel(path)} (exists)`));
        return;
      }
    } catch { /* doesn't exist, good */ }

    await fs.writeFile(path, content, 'utf-8');
    this.result.filesCreated.push(path);
    this.log(chalk.green(`  created ${this.rel(path)}`));
  }

  private rel(path: string): string {
    return path.replace(this.target + '/', '');
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
