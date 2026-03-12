import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'path';
import { promises as fs } from 'fs';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { ProviderChain } from '../../providers/ProviderChain.js';
import { getApiKey as getEnvApiKey } from '../../config/EnvVarOverrides.js';
import { getApiKey as getStoredApiKey } from '../../billing/KeychainKeyStore.js';
import { detectTier } from '../../billing/TierDetector.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { readProviders } from '../repl/DataConfig.js';
import { analyzeManifest, proposeAgents, generatePrd } from '../../scaffold/ManifestAnalyzer.js';
import { ProjectScaffolder } from '../../scaffold/ProjectScaffolder.js';
import { FIXED_AGENT_ROLES } from '../../scaffold/prdTypes.js';
import type { AgentProposal } from '../../scaffold/prdTypes.js';

export function createNewCommand(): Command {
  const cmd = new Command('new')
    .description('Scaffold a new AI-orchestrated project');

  // ── Step 1: epam new init ──────────────────────────────────────────────
  cmd.addCommand(
    new Command('init')
      .description('Scaffold directory structure (scripts, dashboards, settings) — no LLM needed')
      .argument('<project-path>', 'Path to the project directory')
      .action(async (projectPath: string) => {
        try {
          await runInit(projectPath);
        } catch (error) {
          process.stderr.write(
            chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`),
          );
          process.exit(1);
        }
      }),
  );

  // ── Step 2: epam new generate ──────────────────────────────────────────
  cmd.addCommand(
    new Command('generate')
      .description('Generate prd.json and agent profiles from manifest.md using LLM')
      .argument('<project-path>', 'Path to the project directory (must contain manifest.md)')
      .option('-m, --model <model>', 'Model to use for generation')
      .option('-p, --provider <provider>', 'Provider to use')
      .option('--prefix <prefix>', 'Story ID prefix (e.g. TODO)')
      .option('--dry-run', 'Generate and display PRD without writing files')
      .option('--no-interactive', 'Skip Q&A and agent confirmation')
      .action(async (projectPath: string, opts) => {
        try {
          await runGenerate(projectPath, opts);
        } catch (error) {
          process.stderr.write(
            chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`),
          );
          process.exit(1);
        }
      }),
  );

  return cmd;
}

// ── Step 1: Scaffold structure (no LLM) ──────────────────────────────────────

async function runInit(projectPath: string): Promise<void> {
  const targetPath = resolve(projectPath);

  console.log();
  console.log(chalk.bold.cyan('Step 1: Scaffold Project Structure'));
  console.log(chalk.dim(`  Target: ${targetPath}`));
  console.log();

  const scaffolder = new ProjectScaffolder({
    targetPath,
    // Empty PRD — will be generated in step 2
    prd: {
      id: '',
      title: '',
      version: '1.0.0',
      lastUpdated: new Date().toISOString().slice(0, 10),
      project: { name: '', description: '', stack: { language: '', runtime: '' } },
      stories: [],
      implementationOrder: {},
      phasesConfig: {},
    },
    projectAgents: [],
    projectName: targetPath.split('/').pop() ?? 'project',
    techStack: [],
    summary: 'Project scaffolded — run `epam new generate` to create PRD from manifest.',
  });

  const result = await scaffolder.scaffold();

  console.log();
  console.log(chalk.bold.green('Scaffolding complete!'));
  console.log();
  console.log(chalk.dim(`  Files created: ${result.filesCreated.length}`));
  console.log(chalk.dim(`  Files skipped: ${result.filesSkipped.length}`));
  console.log(chalk.dim(`  Dirs created:  ${result.dirsCreated.length}`));
  console.log();
  console.log(chalk.bold('Next:'));
  console.log(`  1. Write your manifest: ${chalk.cyan(targetPath + '/manifest.md')}`);
  console.log(`  2. Generate PRD:        ${chalk.cyan('epam new generate ' + projectPath + ' --provider claude')}`);
  console.log();
}

// ── Step 2: Generate PRD from manifest (LLM) ────────────────────────────────

async function runGenerate(
  projectPath: string,
  opts: {
    model?: string;
    provider?: string;
    prefix?: string;
    dryRun?: boolean;
    interactive?: boolean;
  },
): Promise<void> {
  const targetPath = resolve(projectPath);

  // ── Read manifest ──────────────────────────────────────────────────────
  const manifestPath = resolve(targetPath, 'manifest.md');
  let manifestText: string;
  try {
    manifestText = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    console.log(chalk.red(`manifest.md not found at: ${manifestPath}`));
    console.log(chalk.dim('Create a manifest.md in the project directory first.'));
    process.exit(1);
  }

  console.log();
  console.log(chalk.bold.cyan('Step 2: Generate PRD from Manifest'));
  console.log(chalk.dim(`  Target: ${targetPath}`));
  console.log(chalk.dim(`  Manifest: ${manifestPath} (${manifestText.length} chars)`));
  console.log();

  // ── Set up provider ────────────────────────────────────────────────────
  let requestedProvider: string | undefined = opts.provider;
  let requestedModel: string | undefined = opts.model;
  if (requestedProvider) {
    const providers = readProviders();
    if (!Object.keys(providers).includes(requestedProvider)) {
      console.log(chalk.red(`Unknown provider: ${requestedProvider}`));
      process.exit(1);
    }
    if (!requestedModel) {
      requestedModel = providers[requestedProvider]?.defaultModel;
    }
  }

  const config = await resolveConfig({
    model: requestedModel,
    provider: requestedProvider,
  });

  const authManager = new AuthManager(config.backendUrl);
  const tier = await detectTier();

  // If BYOK key is available for the requested provider, skip proxy
  // to avoid routing through a backend that may not be reachable
  const providerToCheck = requestedProvider ?? config.provider;
  const hasByokKey = !!(
    getEnvApiKey(providerToCheck) ??
    getEnvApiKey(config.provider) ??
    await getStoredApiKey(providerToCheck) ??
    await getStoredApiKey(config.provider)
  );
  const useProxy = !hasByokKey && (tier === 'pro' || tier === 'enterprise');

  const chain = new ProviderChain({
    slots: config.llmChain,
    resolveApiKey: async (providerName: string) => {
      return getEnvApiKey(providerName) ?? await getStoredApiKey(providerName);
    },
    proxyConfig: useProxy ? {
      backendUrl: config.backendUrl,
      getAccessToken: () => authManager.getValidToken(),
    } : undefined,
  });
  if (!requestedProvider) {
    await chain.initialize();
  }

  const provider = chain;
  const model = config.model;

  console.log(chalk.dim(`  Provider: ${config.provider} / ${model}`));
  console.log();

  // ── Phase A: Analyze manifest ──────────────────────────────────────────
  console.log(chalk.bold('Step 1/3: Analyzing manifest...'));
  const analysis = await analyzeManifest(provider, model, manifestText);

  console.log();
  console.log(chalk.bold('  Summary:') + ` ${analysis.summary}`);
  console.log(chalk.bold('  Project:') + ` ${analysis.projectName}`);
  console.log(chalk.bold('  Prefix:') + `  ${analysis.suggestedPrefix}`);
  console.log(chalk.bold('  Stack:') + `   ${analysis.techStack.join(', ')}`);
  console.log();

  // ── Phase A.5: Interactive Q&A ─────────────────────────────────────────
  const qaPairs: Array<{ question: string; answer: string }> = [];
  const isInteractive = opts.interactive !== false && process.stdin.isTTY;

  let prefix = opts.prefix ?? analysis.suggestedPrefix;

  if (isInteractive && analysis.questions.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      // Confirm prefix
      const prefixAnswer = await rl.question(
        chalk.cyan(`  Story ID prefix [${prefix}]: `),
      );
      if (prefixAnswer.trim()) prefix = prefixAnswer.trim().toUpperCase();

      console.log();
      console.log(chalk.bold('  Clarifying questions:'));
      console.log(chalk.dim('  (press Enter to skip, type "done" to skip remaining)'));
      console.log();

      for (let i = 0; i < analysis.questions.length; i++) {
        const q = analysis.questions[i];
        console.log(chalk.white(`  Q${i + 1}: ${q}`));
        const answer = await rl.question(chalk.cyan('  A: '));

        if (answer.trim().toLowerCase() === 'done') break;
        if (answer.trim()) {
          qaPairs.push({ question: q, answer: answer.trim() });
        }
      }
    } finally {
      rl.close();
    }
  }

  console.log();

  // ── Phase B: Propose agents ────────────────────────────────────────────
  console.log(chalk.bold('Step 2/3: Proposing agent roles...'));
  const proposedAgents = await proposeAgents(provider, model, manifestText, qaPairs);

  console.log();
  console.log(chalk.bold('  Fixed roles:') + chalk.dim(` (${FIXED_AGENT_ROLES.length} always present)`));
  for (const role of FIXED_AGENT_ROLES) {
    console.log(chalk.dim(`    ${role}`));
  }

  console.log();
  console.log(chalk.bold('  Proposed project roles:'));
  const confirmedAgents: AgentProposal[] = [...proposedAgents];

  for (let i = 0; i < confirmedAgents.length; i++) {
    const a = confirmedAgents[i];
    console.log(`    ${chalk.green(i + 1)}. ${chalk.cyan(a.name)} — ${chalk.dim(a.rationale)}`);
  }

  // ── Phase B.5: Agent confirmation ──────────────────────────────────────
  if (isInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log();
      console.log(chalk.dim('  Commands: accept, remove <n>, add <name>, done'));
      let editing = true;
      while (editing) {
        const cmd = await rl.question(chalk.cyan('  Agent roster> '));
        const trimmed = cmd.trim().toLowerCase();

        if (!trimmed || trimmed === 'accept' || trimmed === 'done') {
          editing = false;
        } else if (trimmed.startsWith('remove ')) {
          const idx = parseInt(trimmed.slice(7), 10) - 1;
          if (idx >= 0 && idx < confirmedAgents.length) {
            const removed = confirmedAgents.splice(idx, 1)[0];
            console.log(chalk.yellow(`    Removed: ${removed.name}`));
          } else {
            console.log(chalk.red(`    Invalid index. Range: 1-${confirmedAgents.length}`));
          }
        } else if (trimmed.startsWith('add ')) {
          const name = trimmed.slice(4).trim();
          if (name) {
            confirmedAgents.push({
              name,
              systemPrompt: `You are the ${name} for this project.`,
              rationale: 'User-added role',
            });
            console.log(chalk.green(`    Added: ${name}`));
          }
        } else {
          console.log(chalk.dim('    Commands: accept, remove <n>, add <name>, done'));
        }
      }
    } finally {
      rl.close();
    }
  }

  const confirmedRoleNames = confirmedAgents.map(a => a.name);
  console.log();

  // ── Phase C: Generate PRD ──────────────────────────────────────────────
  console.log(chalk.bold('Step 3/3: Generating PRD...'));
  console.log(chalk.dim(`  Prefix: ${prefix}, Roles: ${FIXED_AGENT_ROLES.length} fixed + ${confirmedRoleNames.length} project`));

  const prd = await generatePrd(provider, model, manifestText, qaPairs, confirmedRoleNames, prefix);

  console.log(chalk.green(`  Generated ${prd.stories?.length ?? 0} stories across ${Object.keys(prd.implementationOrder ?? {}).length} phases`));
  console.log();

  if (opts.dryRun) {
    console.log(chalk.bold('PRD (dry-run):'));
    console.log(JSON.stringify(prd, null, 2));
    return;
  }

  // ── Write PRD and profiles into existing scaffold ──────────────────────
  console.log(chalk.bold('Writing PRD and profiles...'));
  console.log();

  const prdPath = resolve(targetPath, 'orchestrations', 'prd.json');
  const profilesPath = resolve(targetPath, 'orchestrations', 'agents', 'profiles.json');
  const kbPath = resolve(targetPath, 'orchestrations', 'agents', 'KB.md');

  // Write prd.json (always overwrite)
  await fs.writeFile(prdPath, JSON.stringify(prd, null, 2), 'utf-8');
  console.log(chalk.green(`  written ${chalk.bold('orchestrations/prd.json')}`));

  // Merge project agents into existing profiles.json
  let existingProfiles: Record<string, string> = {};
  try {
    existingProfiles = JSON.parse(await fs.readFile(profilesPath, 'utf-8'));
  } catch { /* start fresh if missing */ }
  for (const agent of confirmedAgents) {
    existingProfiles[agent.name] = agent.systemPrompt;
  }
  await fs.writeFile(profilesPath, JSON.stringify(existingProfiles, null, 2), 'utf-8');
  console.log(chalk.green(`  written ${chalk.bold('orchestrations/agents/profiles.json')}`));

  // Update KB.md with project context
  const kbContent = `# Shared Knowledge Base

Shared context available to all agents during orchestrated execution.

## Project: ${analysis.projectName}

${analysis.summary}

- **Tech Stack**: ${analysis.techStack.join(', ')}

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
  await fs.writeFile(kbPath, kbContent, 'utf-8');
  console.log(chalk.green(`  written ${chalk.bold('orchestrations/agents/KB.md')}`));

  // ── Summary ────────────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold.green('PRD generated successfully!'));
  console.log();
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Review the PRD:   ${chalk.cyan('cat ' + projectPath + '/orchestrations/prd.json')}`);
  console.log(`  2. Serve dashboards: ${chalk.cyan('cd ' + projectPath + '/orchestrations/dashboards && npx @11ty/eleventy --serve')}`);
  console.log(`  3. Run spec pass:    ${chalk.cyan('epam orchestrate --phase <phase>')}`);
  console.log();
}
