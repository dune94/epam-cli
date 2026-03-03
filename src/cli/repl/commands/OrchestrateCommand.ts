/**
 * /orchestrate Slash Command
 * 
 * Launch and monitor multi-agent orchestration from within chat.
 */

import chalk from 'chalk';
import { execa } from 'execa';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

interface OrchestrationState {
  pid?: number;
  phase?: string;
  startedAt?: number;
  logFile?: string;
  statusFile?: string;
}

const STATE_FILE = '.epam/orchestration-state.json';
const PROGRESS_LOG = 'orchestrations/logs/progress.txt';

export const orchestrateCommand: SlashCommand = {
  name: 'orchestrate',
  aliases: ['orch'],
  description: 'Launch and monitor multi-agent orchestration',
  usage: '<estimate|execution|status> [phase]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim();
    
    if (!trimmedArgs) {
      showHelp();
      return true;
    }
    
    const parts = trimmedArgs.split(/\s+/);
    const subcommand = parts[0].toLowerCase();
    const phase = parts[1];
    
    if (subcommand === 'estimate') {
      if (!phase) {
        console.log(chalk.red('Error: Phase name required'));
        console.log(chalk.dim('Usage: /orchestrate estimate <phase>'));
        return true;
      }
      return await showEstimate(phase, ctx);
    }
    
    if (subcommand === 'execution' || subcommand === 'exec') {
      if (!phase) {
        console.log(chalk.red('Error: Phase name required'));
        console.log(chalk.dim('Usage: /orchestrate execution <phase>'));
        return true;
      }
      return await launchExecution(phase, ctx);
    }
    
    if (subcommand === 'status') {
      return await showStatus(ctx);
    }
    
    if (subcommand === 'help') {
      showHelp();
      return true;
    }
    
    console.log(chalk.red(`Unknown command: ${subcommand}`));
    showHelp();
    return true;
  },
};

/**
 * Show estimate for a phase
 */
async function showEstimate(phase: string, ctx: SlashCommandContext): Promise<boolean> {
  const prdPath = join(process.cwd(), 'orchestrations', 'prd.json');
  
  if (!existsSync(prdPath)) {
    console.log(chalk.red('Error: prd.json not found'));
    console.log(chalk.dim('Make sure you are in a project with orchestrations'));
    return true;
  }
  
  const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
  const phaseStories = prd.implementationOrder?.[phase] || [];
  
  if (phaseStories.length === 0) {
    console.log(chalk.red(`Error: Phase '${phase}' not found`));
    console.log(chalk.dim('Available phases:'), Object.keys(prd.implementationOrder || {}).join(', '));
    return true;
  }
  
  const stories = phaseStories.map((id: string) => 
    prd.stories.find((s: any) => s.id === id)
  ).filter(Boolean);
  
  console.log();
  console.log(chalk.bold.cyan(`📊 Phase Estimate: ${phase}`));
  console.log();
  console.log(chalk.dim(`Stories (${stories.length}):`));
  
  let totalHours = 0;
  let totalCost = 0;
  
  for (const story of stories) {
    const hours = story.estimatedHours || 0;
    const cost = story.estimatedCost || 0;
    totalHours += hours;
    totalCost += cost;
    
    console.log(
      `  ${chalk.cyan(story.id)}: ${chalk.white(story.title)}`
    );
    console.log(
      chalk.dim(`     ${hours}h est, ~$${cost.toFixed(2)} AI cost`)
    );
  }
  
  console.log();
  console.log(chalk.bold('Summary:'));
  console.log(`  ${chalk.white(totalHours.toFixed(1))}h human effort`);
  console.log(`  ${chalk.green(`~$${totalCost.toFixed(2)}`)} AI cost`);
  console.log(`  ${chalk.dim('~' + Math.ceil(totalHours * 0.5))} minutes runtime (parallel)`);
  console.log();
  
  return true;
}

/**
 * Launch orchestration in background
 */
async function launchExecution(phase: string, ctx: SlashCommandContext): Promise<boolean> {
  const scriptPath = join(process.cwd(), 'orchestrations', 'scripts', 'run-agent-orchestration.sh');
  
  if (!existsSync(scriptPath)) {
    console.log(chalk.red('Error: Orchestration script not found'));
    console.log(chalk.dim(`Expected: ${scriptPath}`));
    return true;
  }
  
  console.log();
  console.log(chalk.bold.green(`🚀 Launching orchestration: ${phase}`));
  console.log();
  
  try {
    // Launch in background
    const child = execa('bash', [scriptPath, '--phase', phase], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    
    const pid = child.pid;
    
    // Save state
    const state: OrchestrationState = {
      pid,
      phase,
      startedAt: Date.now(),
      logFile: join(process.cwd(), PROGRESS_LOG),
      statusFile: join(process.cwd(), STATE_FILE),
    };
    
    // Try to save state file
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(join(process.cwd(), STATE_FILE), JSON.stringify(state, null, 2));
    } catch {
      // Ignore if can't write
    }
    
    console.log(chalk.dim(`PID: ${pid}`));
    console.log(chalk.dim(`Logs: ${state.logFile}`));
    console.log();
    console.log(chalk.bold.cyan('📊 Live Status:'));
    console.log(`   Phase: ${chalk.white(phase)}`);
    console.log(`   Progress: ${chalk.white('0/0')} stories`);
    console.log(`   Runtime: ${chalk.white('0m')}`);
    console.log();
    console.log(chalk.bold.cyan('🔗 Dashboard:'));
    console.log(chalk.dim(`   http://localhost:8092/monitor.html`));
    console.log();
    console.log(chalk.dim('Tip: Use /orchestrate status to check progress'));
    console.log();
    
  } catch (err) {
    console.log(chalk.red('Error launching orchestration'));
    console.log(chalk.dim((err as Error).message));
  }
  
  return true;
}

/**
 * Show current orchestration status
 */
async function showStatus(ctx: SlashCommandContext): Promise<boolean> {
  const stateFile = join(process.cwd(), STATE_FILE);
  const prdPath = join(process.cwd(), 'orchestrations', 'prd.json');
  
  console.log();
  console.log(chalk.bold.cyan('📊 Orchestration Status'));
  console.log();
  
  // Check if orchestration is running
  if (!existsSync(stateFile)) {
    console.log(chalk.dim('No active orchestration'));
    console.log(chalk.dim('Use /orchestrate execution <phase> to start'));
    console.log();
    return true;
  }
  
  let state: OrchestrationState;
  try {
    const { readFileSync } = await import('fs');
    state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    console.log(chalk.red('Error reading orchestration state'));
    return true;
  }
  
  // Check if process is still running
  let isRunning = false;
  try {
    process.kill(state.pid!, 0);
    isRunning = true;
  } catch {
    isRunning = false;
  }
  
  if (!isRunning) {
    console.log(chalk.green('✓ Orchestration completed'));
    console.log(chalk.dim(`Phase: ${state.phase}`));
    console.log();
    return true;
  }
  
  // Show live status
  console.log(chalk.bold(`Phase: ${chalk.white(state.phase || 'unknown')}`));
  
  // Calculate runtime
  const runtimeMin = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 60000) : 0;
  console.log(`Runtime: ${chalk.white(runtimeMin + 'm')}`);
  
  // Parse progress from PRD
  if (existsSync(prdPath) && state.phase) {
    const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
    const phaseStories = prd.implementationOrder?.[state.phase] || [];
    const completedCount = phaseStories.filter((id: string) => {
      const story = prd.stories.find((s: any) => s.id === id);
      return story?.completed;
    }).length;
    
    console.log(`Progress: ${chalk.green(completedCount)}/${chalk.white(phaseStories.length)} stories`);
    
    // Show current story
    const currentStory = phaseStories.find((id: string) => {
      const story = prd.stories.find((s: any) => s.id === id);
      return !story?.completed;
    });
    
    if (currentStory) {
      const story = prd.stories.find((s: any) => s.id === currentStory);
      console.log(`Current: ${chalk.cyan(story?.id)} ${chalk.dim('(' + story?.title + ')')}`);
    }
  }
  
  console.log();
  console.log(chalk.bold.cyan('🔗 Dashboard:'));
  console.log(chalk.dim(`   http://localhost:8092/monitor.html`));
  console.log();
  
  return true;
}

/**
 * Show help
 */
function showHelp(): void {
  console.log();
  console.log(chalk.bold('Orchestration Commands:'));
  console.log();
  console.log(chalk.cyan('  /orchestrate estimate <phase>'));
  console.log(chalk.dim('    Show time and cost estimate for a phase'));
  console.log();
  console.log(chalk.cyan('  /orchestrate execution <phase>'));
  console.log(chalk.dim('    Launch orchestration in background'));
  console.log();
  console.log(chalk.cyan('  /orchestrate status'));
  console.log(chalk.dim('    Show current orchestration progress'));
  console.log();
  console.log(chalk.cyan('  /orchestrate help'));
  console.log(chalk.dim('    Show this help message'));
  console.log();
  console.log(chalk.dim('Example:'));
  console.log(chalk.dim('  /orchestrate estimate mvp_cli_control'));
  console.log(chalk.dim('  /orchestrate execution mvp_cli_control'));
  console.log(chalk.dim('  /orchestrate status'));
  console.log();
}
