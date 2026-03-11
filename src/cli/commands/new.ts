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
  return new Command('new')
    .description('Scaffold a new AI-orchestrated project from a manifest')
    .argument('<project-path>', 'Path to the project directory (must contain manifest.md)')
    .option('-m, --model <model>', 'Model to use for generation')
    .option('-p, --provider <provider>', 'Provider to use')
    .option('--prefix <prefix>', 'Story ID prefix (e.g. TODO)')
    .option('--dry-run', 'Generate and display PRD without writing files')
    .option('--no-interactive', 'Skip Q&A and agent confirmation')
    .action(async (projectPath: string, opts) => {
      try {
        await runNew(projectPath, opts);
      } catch (error) {
        process.stderr.write(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`),
        );
        process.exit(1);
      }
    });
}

async function runNew(
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
  console.log(chalk.bold.cyan('New Project Scaffolding'));
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

  const chain = new ProviderChain({
    slots: config.llmChain,
    resolveApiKey: async (providerName: string) => {
      return getEnvApiKey(providerName) ?? await getStoredApiKey(providerName);
    },
    proxyConfig: (tier === 'pro' || tier === 'enterprise') ? {
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
  console.log(chalk.bold('Step 1/4: Analyzing manifest...'));
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
  console.log(chalk.bold('Step 2/4: Proposing agent roles...'));
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
  console.log(chalk.bold('Step 3/4: Generating PRD...'));
  console.log(chalk.dim(`  Prefix: ${prefix}, Roles: ${FIXED_AGENT_ROLES.length} fixed + ${confirmedRoleNames.length} project`));

  const prd = await generatePrd(provider, model, manifestText, qaPairs, confirmedRoleNames, prefix);

  console.log(chalk.green(`  Generated ${prd.stories?.length ?? 0} stories across ${Object.keys(prd.implementationOrder ?? {}).length} phases`));
  console.log();

  if (opts.dryRun) {
    console.log(chalk.bold('PRD (dry-run):'));
    console.log(JSON.stringify(prd, null, 2));
    return;
  }

  // ── Phase D: Scaffold filesystem ───────────────────────────────────────
  console.log(chalk.bold('Step 4/4: Scaffolding project...'));
  console.log();

  const scaffolder = new ProjectScaffolder({
    targetPath,
    prd,
    projectAgents: confirmedAgents,
    projectName: analysis.projectName,
    techStack: analysis.techStack,
    summary: analysis.summary,
  });

  const result = await scaffolder.scaffold();

  // ── Summary ────────────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold.green('Project scaffolded successfully!'));
  console.log();
  console.log(chalk.dim(`  Files created: ${result.filesCreated.length}`));
  console.log(chalk.dim(`  Files skipped: ${result.filesSkipped.length}`));
  console.log(chalk.dim(`  Dirs created:  ${result.dirsCreated.length}`));
  console.log();
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Review the PRD:   ${chalk.cyan('cd ' + projectPath + ' && cat orchestrations/prd.json')}`);
  console.log(`  2. Serve dashboards: ${chalk.cyan('cd orchestrations/dashboards && npx @11ty/eleventy --serve')}`);
  console.log(`  3. Run spec pass:    ${chalk.cyan('epam orchestrate --phase <phase>')}`);
  console.log();
}
