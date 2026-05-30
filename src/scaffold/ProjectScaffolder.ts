// ── ProjectScaffolder — writes a complete orchestration workspace ─────────────

import { promises as fs } from 'fs';
import { join, resolve, dirname } from 'path';
import chalk from 'chalk';
import type { PrdSchema, PrdStory, AgentProposal } from './prdTypes.js';
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
    await this.seedRuntimeLogs();

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

    // Step 9: Copy orchestration prompts
    await this.copyOrchestrationPrompts();

    // Step 10: Copy dashboards
    await this.copyDashboards();

    // Step 11: Create dashboard symlinks
    await this.createDashboardSymlinks();

    // Step 12: Write orchestrations/README.md
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
      'orchestrations/prompts',
      'orchestrations/dashboards',
      'orchestrations/logs',
      'orchestrations/logs/phase-improvements',
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
    const prd = this.injectDashboardInfraStories(this.opts.prd);
    await this.writeFile(path, JSON.stringify(prd, null, 2));
  }

  private injectDashboardInfraStories(prd: PrdSchema): PrdSchema {
    const dashStories = this.buildDashboardInfraStories();
    const dashIds = dashStories.map(s => s.id);

    // Idempotent: remove any existing infra stories (INIT-*, DASH-*) before prepending
    const filtered = prd.stories.filter(s => !dashIds.includes(s.id));
    const stories = [...dashStories, ...filtered];

    // Prepend infra IDs to the first phase in implementationOrder
    const order = { ...prd.implementationOrder };
    const phases = Object.keys(order);
    if (phases.length === 0) {
      order['infrastructure'] = dashIds;
    } else {
      const firstPhase = phases[0];
      const existing = (order[firstPhase] ?? []).filter(id => !dashIds.includes(id));
      order[firstPhase] = [...dashIds, ...existing];
    }

    return { ...prd, stories, implementationOrder: order };
  }

  private buildDashboardInfraStories(): PrdStory[] {
    return [
      {
        id: 'INIT-001',
        title: 'Initialize project agent profiles and verify infrastructure',
        description: 'Generate rich, project-specific system prompts for all project-defined agent roles from manifest.md and prd.json context. Verify dashboard templates are present before DASH-001 can run.',
        priority: 'critical',
        status: 'pending',
        completed: false,
        agentGroup: 'main',
        agentRole: 'project-initiator-agent',
        storyType: 'infrastructure',
        dependencies: [],
        estimatedHours: 0.5,
        effort: 'low',
        technicalNotes: {
          files: [
            'manifest.md',
            'orchestrations/prd.json',
            'orchestrations/agents/profiles.json',
            'orchestrations/agents/KB.md',
            'orchestrations/dashboards/templates/base-dashboard.html',
            'orchestrations/logs/init-manifest.json',
          ],
          requiredSkills: ['project-initiator-agent'],
        },
        acceptanceCriteria: [
          'manifest.md read and project context fully extracted (name, tech stack, constraints, domain vocabulary)',
          'All project-specific agent roles in profiles.json enriched with project-aware system prompts (≥400 words each)',
          'Fixed infrastructure roles (spec-coordinator, team-lead, dashboard agents, etc.) left unchanged in profiles.json',
          'orchestrations/dashboards/templates/base-dashboard.html confirmed present — blocker if missing',
          'orchestrations/dashboards/templates/dashboard-config.schema.json confirmed present — blocker if missing',
          'orchestrations/logs/init-manifest.json written with projectName, techStack, storyCount, agentProfilesEnriched, templatesVerified',
          'KB.md updated with any critical project context not already captured',
        ],
      },
      {
        id: 'INIT-002',
        title: 'Validate and repair prd.json structure',
        description: 'Validate the full prd.json schema: story dependencies, agentRole references, AC quality, phase configuration, and estimation consistency. Fix any correctable issues before implementation begins.',
        priority: 'critical',
        status: 'pending',
        completed: false,
        agentGroup: 'main',
        agentRole: 'prd-project-manager-agent',
        storyType: 'infrastructure',
        dependencies: ['INIT-001'],
        estimatedHours: 0.25,
        effort: 'low',
        technicalNotes: {
          files: [
            'orchestrations/prd.json',
            'orchestrations/agents/profiles.json',
            'orchestrations/logs/prd-governance.jsonl',
          ],
          requiredSkills: ['prd-project-manager-agent'],
        },
        acceptanceCriteria: [
          'Every story ID in implementationOrder exists in stories[] with no orphans or duplicates',
          'Every story.agentRole references an existing entry in profiles.json',
          'Every story.dependencies[] entry references a valid story ID in the same PRD',
          'Phase ordering is acyclic — no circular dependencies between phases',
          'All stories have ≥2 acceptanceCriteria entries (placeholder ACs added with TODO: prefix where missing)',
          'All phasesConfig entries exist for every phase in implementationOrder',
          'orchestrations/logs/prd-governance.jsonl written with findings and a governance-complete summary line',
          'prd.json is valid JSON after all corrections are applied',
        ],
      },
      {
        id: 'DASH-001',
        title: 'Initialize project dashboard infrastructure',
        description: 'Generate custom project dashboard from base Chart.js templates. Assess results from dashboard-test-agent and dashboard-update-agent before marking complete.',
        priority: 'critical',
        status: 'pending',
        completed: false,
        agentGroup: 'main',
        agentRole: 'dashboard-orchestrator-agent',
        storyType: 'infrastructure',
        dependencies: ['INIT-001'],
        estimatedHours: 0.5,
        effort: 'low',
        technicalNotes: {
          files: [
            'dashboard/index.html',
            'dashboard/config.json',
            'orchestrations/dashboards/templates/base-dashboard.html',
          ],
          requiredSkills: ['dashboard-orchestrator-agent'],
        },
        acceptanceCriteria: [
          'Base templates located and readable from orchestrations/dashboards/templates/',
          'dashboard/index.html generated with project-specific Chart.js configuration',
          'dashboard/config.json populated with project metadata, phase names, and story IDs',
          'Control plane components present: pause button (id=pause-btn), redirect panel (id=redirect-panel), story status list (id=story-status)',
          'dashboard/ directory added to .gitignore',
          'dashboard-test-agent assessment verdict is PASS',
          'dashboard-update-agent assessment verdict is PASS',
          'Completion record appended to orchestrations/logs/dashboard-init.jsonl',
        ],
      },
      {
        id: 'DASH-002',
        title: 'Validate dashboard infrastructure',
        description: 'Test the generated dashboard from DASH-001. Verify HTML validity, Chart.js bindings, control plane components, and PRD cross-reference accuracy. Write test-report.json and pass to dashboard-orchestrator-agent.',
        priority: 'critical',
        status: 'pending',
        completed: false,
        agentGroup: 'main',
        agentRole: 'dashboard-test-agent',
        storyType: 'infrastructure',
        dependencies: ['DASH-001'],
        estimatedHours: 0.25,
        effort: 'low',
        technicalNotes: {
          files: [
            'dashboard/index.html',
            'dashboard/config.json',
            'dashboard/test-report.json',
          ],
          requiredSkills: ['dashboard-test-agent'],
        },
        acceptanceCriteria: [
          'dashboard/index.html and dashboard/config.json exist and are non-empty',
          'dashboard/index.html is valid HTML with no unclosed tags and no unresolved template variables',
          'All Chart.js canvas elements have corresponding config entries with valid labels and datasets',
          'Control plane components present: id=pause-btn, id=redirect-panel, id=story-status',
          'All phase names and story IDs in dashboard/config.json match orchestrations/prd.json',
          'dashboard/test-report.json written with verdict and structured check results',
          'Test report sent to dashboard-orchestrator-agent via message bus',
        ],
      },
      {
        id: 'DASH-003',
        title: 'Validate real-time dashboard update pipeline',
        description: 'Verify the end-to-end JSONL update pipeline: update-monitor.sh, sync-monitor-stories.sh, live write/read cycle, stale lock detection, and agent-status.json schema validity. Write update-report.json and pass to dashboard-orchestrator-agent.',
        priority: 'critical',
        status: 'pending',
        completed: false,
        agentGroup: 'main',
        agentRole: 'dashboard-update-agent',
        storyType: 'infrastructure',
        dependencies: ['DASH-001', 'DASH-002'],
        estimatedHours: 0.25,
        effort: 'low',
        technicalNotes: {
          files: [
            'orchestrations/logs/agent-activity.jsonl',
            'orchestrations/logs/agent-status.json',
            'dashboard/update-report.json',
          ],
          requiredSkills: ['dashboard-update-agent'],
        },
        acceptanceCriteria: [
          'update-monitor.sh is executable and exits 0 with valid agent-status.json output',
          'sync-monitor-stories.sh is callable without errors',
          'No stale JSONL lock files present (none with mtime older than 5 minutes)',
          'Live write/read cycle completes: test entry written to agent-activity.jsonl and readable within 10 seconds',
          'agent-status.json contains required fields: startedAt, phase, orchMode, lanes, events, stories, completedAt',
          'Write latency P99 measured and recorded (warn if >100ms, not blocking)',
          'Dashboard polling interval configured at <=5000ms',
          'dashboard/update-report.json written and sent to dashboard-orchestrator-agent via message bus',
          'All test JSONL entries written during validation cleaned up before completion',
        ],
      },
      {
        id: 'SKILLS-001',
        title: 'Post-spec skills gap analysis and profile enrichment',
        description: 'After openspec and speckit have elaborated all stories, scan elaborated ACs and requiredSkills for technical terms not covered by assigned agent profiles. Append targeted skill addendums to close closeable gaps; flag blocker-severity mismatches for human review.',
        priority: 'high',
        status: 'pending',
        completed: false,
        agentGroup: 'main',
        agentRole: 'agent-skills-agent',
        storyType: 'health_check',
        dependencies: ['DASH-003'],
        estimatedHours: 0.25,
        effort: 'low',
        technicalNotes: {
          files: [
            'orchestrations/prd.json',
            'orchestrations/agents/profiles.json',
            'orchestrations/logs/skills-gap-report.jsonl',
          ],
          requiredSkills: ['agent-skills-agent'],
        },
        acceptanceCriteria: [
          'Spec elaboration precondition verified — halts with WARN if stories are not yet elaborated',
          'All non-infrastructure stories grouped by agentRole and analysed in a single pass per role',
          'Missing skills extracted from elaborated ACs and technicalNotes.requiredSkills (concrete terms only, no speculation)',
          'Closeable gaps (major/minor) resolved by appending a Post-Spec Skill Addendum to the affected profile',
          'Addendum is concise (≤200 words), grounded in specific story IDs and ACs, never rewrites the base prompt',
          'Blocker-severity gaps (domain mismatch) logged as reassignment recommendations — not applied to profiles',
          'Infrastructure agent profiles (INIT-*, DASH-*, team-lead, review, spec, test, gate agents) left unmodified',
          'orchestrations/logs/skills-gap-report.jsonl written with per-gap findings and a skills-check-complete summary line',
        ],
      },
    ];
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

  // ── Copy orchestration prompts ───────────────────────────────────────────

  private async copyOrchestrationPrompts(): Promise<void> {
    const sourceDir = await this.findSourceDir('orchestrations/prompts');
    if (!sourceDir) {
      this.log(chalk.yellow('  Skipping prompts copy — source not found'));
      return;
    }

    await this.copyDirRecursive(
      sourceDir,
      join(this.target, 'orchestrations', 'prompts'),
    );
  }

  // ── Seed runtime logs ────────────────────────────────────────────────────

  private async seedRuntimeLogs(): Promise<void> {
    const logsDir = join(this.target, 'orchestrations', 'logs');
    await this.ensureDir(logsDir);

    const jsonlLogs = [
      'agent-activity.jsonl',
      'agent-messages.jsonl',
      'code-reviews.jsonl',
      'cpa-review.jsonl',
      'phase-cost.jsonl',
      'phase-gates.jsonl',
      'profiles-audit.jsonl',
      'testing-gates.jsonl',
    ];
    for (const name of jsonlLogs) {
      await this.writeFileIfMissing(join(logsDir, name), '');
    }

    const statusPath = join(logsDir, 'agent-status.json');
    await this.writeFileIfMissing(statusPath, JSON.stringify({
      startedAt: null,
      phase: null,
      orchMode: null,
      lanes: {
        main: { status: 'idle', currentStory: null, storiesCompleted: 0, storiesFailed: 0 },
        primary: { status: 'idle', currentStory: null, storiesCompleted: 0, storiesFailed: 0 },
        independent: { status: 'idle', currentStory: null, storiesCompleted: 0, storiesFailed: 0 },
      },
      events: [],
      stories: {},
      completedAt: null,
    }, null, 2));
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

  private async writeFileIfMissing(path: string, content: string): Promise<void> {
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, content, 'utf-8');
      this.result.filesCreated.push(path);
      this.log(chalk.green(`  created ${this.rel(path)}`));
    }
  }

  private rel(path: string): string {
    return path.replace(this.target + '/', '');
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
