/**
 * /orchestrate Slash Command
 *
 * Subcommands:
 *   /orchestrate              — show current config, phases, and help
 *   /orchestrate setup [k=v]  — configure defaults saved to .epam/orchestration.json
 *   /orchestrate spec <p>     — run specification agents before estimates
 *   /orchestrate estimate <p> — run estimate-stories.sh + CPA pass for a phase
 *   /orchestrate execution <p>— launch run-agent-orchestration.sh (detached)
 *   /orchestrate status       — show progress of last launched run
 *   /orchestrate help         — show help
 *
 * NOTE: All subcommands are arg-driven (no interactive readline prompts).
 * The REPL uses RawInputBox for TTY input, and rl.question() conflicts
 * with raw mode — causing session termination on EOF.
 */

import chalk from 'chalk';
import { spawn } from 'child_process';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { join, resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readProviders } from '../DataConfig.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface OrchestrationConfig {
  provider?: string;
  mode?: 'bash' | 'hybrid';
  prdFile?: string;
  outputDir?: string;
  skipCpa?: boolean;
  strictCpa?: boolean;
  worktree?: boolean;
}

const CONFIG_FILE = '.epam/orchestration.json';
const STATE_FILE  = '.epam/orchestration-state.json';

function readConfig(): OrchestrationConfig {
  const p = join(process.cwd(), CONFIG_FILE);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}

function writeConfig(cfg: OrchestrationConfig): void {
  const dir = join(process.cwd(), '.epam');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(process.cwd(), CONFIG_FILE), JSON.stringify(cfg, null, 2));
}

// ── PRD helpers ─────────────────────────────────────────────────────────────

function readPrd(cfg: OrchestrationConfig): { phases: string[]; stories: any[] } | null {
  const prdPath = cfg.prdFile
    ? resolve(process.cwd(), cfg.prdFile)
    : join(process.cwd(), 'orchestrations', 'prd.json');
  if (!existsSync(prdPath)) return null;
  try {
    const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
    return {
      phases: Object.keys(prd.implementationOrder ?? {}),
      stories: prd.stories ?? [],
    };
  } catch { return null; }
}

// ── Script runner ────────────────────────────────────────────────────────────

function runScript(script: string, args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise((res, reject) => {
    const child = spawn('bash', [script, ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('close', code => res(code ?? 1));
  });
}

// ── setup (arg-driven) ─────────────────────────────────────────────────────

function runSetup(argsStr: string): boolean {
  const existing = readConfig();
  const providers = Object.keys(readProviders());

  // No args → show current config + usage
  if (!argsStr.trim()) {
    console.log();
    console.log(chalk.bold.cyan('Orchestration Setup'));
    console.log();

    const cfg = existing;
    console.log(`  ${chalk.bold('provider')}:   ${chalk.white(cfg.provider ?? chalk.dim('(default: claude)'))}`);
    console.log(`  ${chalk.bold('mode')}:       ${chalk.white(cfg.mode ?? chalk.dim('(default: bash)'))}`);
    console.log(`  ${chalk.bold('prd')}:        ${chalk.white(cfg.prdFile ?? chalk.dim('(default: orchestrations/prd.json)'))}`);
    console.log(`  ${chalk.bold('outputDir')}:  ${chalk.white(cfg.outputDir ?? chalk.dim('(default: orchestrations/logs)'))}`);
    console.log(`  ${chalk.bold('skipCpa')}:    ${chalk.white(String(cfg.skipCpa ?? false))}`);
    console.log(`  ${chalk.bold('strictCpa')}:  ${chalk.white(String(cfg.strictCpa ?? false))}`);
    console.log(`  ${chalk.bold('worktree')}:   ${chalk.white(String(cfg.worktree ?? false))}`);
    console.log();
    console.log(chalk.dim('Usage: /orchestrate setup <key>=<value> [key=value ...]'));
    console.log(chalk.dim('  provider=copilot   mode=bash|hybrid   prd=path/to/prd.json'));
    console.log(chalk.dim('  outputDir=logs/    skipCpa=true       strictCpa=true   worktree=true'));
    console.log(chalk.dim(`  Providers: ${providers.join(', ')}`));
    console.log();
    return true;
  }

  // Parse key=value pairs
  const pairs = argsStr.trim().split(/\s+/);
  const updates: Partial<OrchestrationConfig> = {};

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) {
      console.log(chalk.red(`Invalid format: ${pair}. Use key=value.`));
      return true;
    }
    const key = pair.slice(0, eqIdx).toLowerCase();
    const val = pair.slice(eqIdx + 1);

    switch (key) {
      case 'provider':
        if (!providers.includes(val)) {
          console.log(chalk.red(`Unknown provider: ${val}. Available: ${providers.join(', ')}`));
          return true;
        }
        updates.provider = val;
        break;
      case 'mode':
        if (val !== 'bash' && val !== 'hybrid') {
          console.log(chalk.red('Mode must be "bash" or "hybrid".'));
          return true;
        }
        updates.mode = val;
        break;
      case 'prd':
      case 'prdfile':
        updates.prdFile = val;
        break;
      case 'outputdir':
      case 'output':
      case 'logs':
        updates.outputDir = val;
        break;
      case 'skipcpa':
        updates.skipCpa = val === 'true' || val === '1' || val === 'yes';
        break;
      case 'strictcpa':
        updates.strictCpa = val === 'true' || val === '1' || val === 'yes';
        break;
      case 'worktree':
        updates.worktree = val === 'true' || val === '1' || val === 'yes';
        break;
      default:
        console.log(chalk.yellow(`Unknown key: ${key}. Ignored.`));
    }
  }

  const cfg: OrchestrationConfig = { ...existing, ...updates };
  writeConfig(cfg);

  console.log();
  console.log(chalk.green('Saved to .epam/orchestration.json'));
  for (const [k, v] of Object.entries(updates)) {
    console.log(chalk.dim(`  ${k}: ${v}`));
  }
  console.log();
  return true;
}

// ── estimate ────────────────────────────────────────────────────────────────

async function runEstimate(phase: string, flags: string[]): Promise<boolean> {
  const cfg = readConfig();

  const estimateScript = join(process.cwd(), 'orchestrations', 'scripts', 'estimate-stories.sh');
  const cpaScript      = join(process.cwd(), 'orchestrations', 'scripts', 'contextualize-stories.sh');

  if (!existsSync(estimateScript)) {
    console.log(chalk.red('Error: estimate-stories.sh not found.'));
    console.log(chalk.dim('Run from the epam-cli project root.'));
    return true;
  }

  const doRefine = flags.includes('--refine');
  const doApply  = flags.includes('--apply');
  const skipCpa  = flags.includes('--skip-cpa') || (cfg.skipCpa ?? false);

  console.log();
  console.log(chalk.bold.cyan(`Estimating phase: ${phase}`));
  if (doRefine) console.log(chalk.dim('  --refine enabled'));
  if (doApply)  console.log(chalk.dim('  --apply enabled'));
  console.log();

  const estArgs = ['--phase', phase];
  if (doRefine) estArgs.push('--refine');
  if (doApply)  estArgs.push('--apply');

  const env: Record<string, string> = {};
  if (cfg.prdFile) env.PRD_FILE = resolve(process.cwd(), cfg.prdFile);
  if (cfg.outputDir) env.OUTPUT_DIR = resolve(process.cwd(), cfg.outputDir);

  const estCode = await runScript(estimateScript, estArgs, env);
  if (estCode !== 0) {
    console.log(chalk.red(`\nEstimation failed (exit ${estCode})`));
    return true;
  }

  if (!skipCpa && existsSync(cpaScript)) {
    console.log();
    console.log(chalk.bold.cyan('Running CPA contextualisation pass...'));
    console.log();
    const cpaArgs = ['--phase', phase];
    if (doApply) cpaArgs.push('--apply');
    if (cfg.strictCpa) cpaArgs.push('--strict');
    const cpaCode = await runScript(cpaScript, cpaArgs, env);
    if (cpaCode === 3) {
      console.log(chalk.red('\nCPA gate: BLOCKED — resolve flagged issues before executing.'));
    } else if (cpaCode === 2) {
      console.log(chalk.yellow('\nCPA gate: REVIEW — some stories have elevated risk.'));
    }
  }

  return true;
}

// ── specification ───────────────────────────────────────────────────────────

async function runSpecification(phase: string, flags: string[]): Promise<boolean> {
  const cfg = readConfig();
  const scriptPath = join(process.cwd(), 'orchestrations', 'scripts', 'spec-mode-runner.js');

  if (!existsSync(scriptPath)) {
    console.log(chalk.red('Error: orchestrations/scripts/spec-mode-runner.js not found.'));
    console.log(chalk.dim('Run from the epam-cli project root.'));
    return true;
  }

  const args = ['--phase', phase];
  if (flags.includes('--dry-run')) args.push('--dry-run');

  const env: Record<string, string> = {};
  if (cfg.prdFile) env.PRD_FILE = resolve(process.cwd(), cfg.prdFile);
  if (cfg.outputDir) env.OUTPUT_DIR = resolve(process.cwd(), cfg.outputDir);
  if (cfg.provider) env.EPAM_ORCHESTRATION_PROVIDER = cfg.provider;

  console.log();
  console.log(chalk.bold.cyan(`Running specification pass for phase: ${phase}`));
  console.log(chalk.dim('  Agents: coordinator + (OpenSpec/Speckit)'));
  if (args.includes('--dry-run')) console.log(chalk.dim('  Dry-run only (no PRD changes)'));
  console.log();

  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', (err) => {
      console.log(chalk.red('Failed to launch specification runner'));
      console.log(chalk.dim((err as Error).message));
      resolve(true);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.log(chalk.red(`Specification pass exited with code ${code}`));
      } else {
        console.log(chalk.green('Specification pass complete'));
      }
      resolve(true);
    });
  });
}

// ── execution ────────────────────────────────────────────────────────────────

async function launchExecution(phase: string): Promise<boolean> {
  const cfg = readConfig();
  const scriptPath = join(process.cwd(), 'orchestrations', 'scripts', 'run-agent-orchestration.sh');

  if (!existsSync(scriptPath)) {
    console.log(chalk.red('Error: run-agent-orchestration.sh not found.'));
    console.log(chalk.dim(`Expected: ${scriptPath}`));
    return true;
  }

  // Build args from saved config
  const args: string[] = ['--phase', phase];
  if (cfg.mode) args.push('--mode', cfg.mode);
  if (cfg.worktree) args.push('--worktree');

  const env: Record<string, string> = {};
  if (cfg.provider)  env.EPAM_ORCHESTRATION_PROVIDER = cfg.provider;
  if (cfg.prdFile)   env.PRD_FILE   = resolve(process.cwd(), cfg.prdFile);
  if (cfg.outputDir) env.OUTPUT_DIR = resolve(process.cwd(), cfg.outputDir);
  if (cfg.skipCpa)   env.SKIP_CPA   = '1';
  if (cfg.strictCpa) env.STRICT_CPA = '1';

  console.log();
  console.log(chalk.bold.green('Launching orchestration'));
  console.log();
  console.log(chalk.dim(`  Phase:    ${phase}`));
  console.log(chalk.dim(`  Provider: ${cfg.provider ?? 'claude (default)'}`));
  console.log(chalk.dim(`  Mode:     ${cfg.mode ?? 'bash (default)'}`));
  if (cfg.outputDir) console.log(chalk.dim(`  Logs:     ${cfg.outputDir}`));
  console.log();

  try {
    const child = spawn('bash', [scriptPath, ...args], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...env },
    });
    child.unref();
    const pid = child.pid;

    const state = { pid, phase, startedAt: Date.now(), config: cfg };
    try {
      writeFileSync(join(process.cwd(), STATE_FILE), JSON.stringify(state, null, 2));
    } catch { /* ignore */ }

    console.log(chalk.green(`Started (PID ${pid})`));
    console.log(chalk.dim('  Use /orchestrate status to check progress'));
    const logsDir = cfg.outputDir
      ? resolve(process.cwd(), cfg.outputDir)
      : join(process.cwd(), 'orchestrations', 'logs');
    console.log(chalk.dim(`  Logs: ${logsDir}`));
  } catch (err) {
    console.log(chalk.red('Error launching orchestration'));
    console.log(chalk.dim((err as Error).message));
  }

  console.log();
  return true;
}

// ── status ───────────────────────────────────────────────────────────────────

async function showStatus(): Promise<boolean> {
  const stateFile = join(process.cwd(), STATE_FILE);

  console.log();
  console.log(chalk.bold.cyan('Orchestration Status'));
  console.log();

  if (!existsSync(stateFile)) {
    console.log(chalk.dim('No active orchestration.'));
    console.log(chalk.dim('Use /orchestrate execution <phase> to start.'));
    console.log();
    return true;
  }

  let state: any;
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')); }
  catch { console.log(chalk.red('Error reading state file.')); return true; }

  let isRunning = false;
  try { process.kill(state.pid, 0); isRunning = true; } catch { /* not running */ }

  console.log(`  Phase:    ${chalk.white(state.phase ?? 'unknown')}`);
  console.log(`  Provider: ${chalk.white(state.config?.provider ?? 'default')}`);

  if (state.startedAt) {
    const mins = Math.floor((Date.now() - state.startedAt) / 60000);
    console.log(`  Runtime:  ${chalk.white(mins + 'm')}`);
  }

  if (!isRunning) {
    console.log(`  Status:   ${chalk.green('Completed')}`);
    console.log();
    return true;
  }

  console.log(`  Status:   ${chalk.yellow('Running')} (PID ${state.pid})`);

  // Progress from PRD
  const cfg: OrchestrationConfig = state.config ?? {};
  const prd = readPrd(cfg);
  if (prd && state.phase) {
    const phaseData = JSON.parse(readFileSync(
      cfg.prdFile ? resolve(process.cwd(), cfg.prdFile) : join(process.cwd(), 'orchestrations', 'prd.json'),
      'utf-8'
    ));
    const phaseIds: string[] = phaseData.implementationOrder?.[state.phase] ?? [];
    const completed = phaseIds.filter(id => prd.stories.find((s: any) => s.id === id)?.completed).length;
    console.log(`  Progress: ${chalk.green(completed)}/${chalk.white(phaseIds.length)} stories`);

    const current = phaseIds.find(id => !prd.stories.find((s: any) => s.id === id)?.completed);
    if (current) {
      const story = prd.stories.find((s: any) => s.id === current);
      console.log(`  Current:  ${chalk.cyan(story?.id)} ${chalk.dim('(' + (story?.title ?? '') + ')')}`);
    }
  }

  console.log();
  return true;
}

// ── overview (no-args) ──────────────────────────────────────────────────────

function showOverview(): boolean {
  const cfg = readConfig();
  const prd = readPrd(cfg);
  const hasConfig = existsSync(join(process.cwd(), CONFIG_FILE));

  console.log();
  console.log(chalk.bold.cyan('Orchestration'));

  if (!hasConfig) {
    console.log(chalk.yellow('  No config found — run /orchestrate setup to configure'));
  } else {
    console.log(chalk.dim(`  Provider: ${cfg.provider ?? 'claude'}  |  Mode: ${cfg.mode ?? 'bash'}`));
  }
  console.log();

  // Show available phases
  if (prd && prd.phases.length > 0) {
    console.log(chalk.bold('Phases:'));
    prd.phases.forEach((p, i) => {
      console.log(`  ${chalk.bold(String(i + 1))}. ${chalk.cyan(p)}`);
    });
    console.log();
  } else {
    console.log(chalk.dim('No phases found in prd.json.'));
    console.log();
  }

  showHelp();
  return true;
}

// ── help ─────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(chalk.bold('Orchestration Commands:'));
  console.log();
  console.log(`  ${chalk.cyan('/orchestrate')}                          ${chalk.dim('Show config + phases')}`);
  console.log(`  ${chalk.cyan('/orchestrate setup')}                    ${chalk.dim('Show current config')}`);
  console.log(`  ${chalk.cyan('/orchestrate setup')} ${chalk.dim('provider=x mode=y')}  ${chalk.dim('Set config values')}`);
  console.log(`  ${chalk.cyan('/orchestrate spec')} ${chalk.dim('<phase>')}             ${chalk.dim('Run specification agents')}`);
  console.log(`  ${chalk.cyan('/orchestrate estimate')} ${chalk.dim('<phase>')}          ${chalk.dim('Run estimation + CPA')}`);
  console.log(`  ${chalk.cyan('/orchestrate execution')} ${chalk.dim('<phase>')}         ${chalk.dim('Launch orchestration')}`);
  console.log(`  ${chalk.cyan('/orchestrate status')}                   ${chalk.dim('Show run progress')}`);
  console.log();
  console.log(chalk.dim('Estimate flags: --refine --apply --skip-cpa'));
  console.log(chalk.dim('Config: .epam/orchestration.json'));
  console.log();
}

// ── entry point ──────────────────────────────────────────────────────────────

export const orchestrateCommand: SlashCommand = {
  name: 'orchestrate',
  aliases: ['orch'],
  description: 'Launch and monitor multi-agent orchestration',
  usage: '[setup [k=v] | spec <phase> | estimate <phase> | execution <phase> | status | help]',

  async execute(args, _ctx): Promise<boolean> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub   = parts[0]?.toLowerCase();

    if (!sub)            return showOverview();
    if (sub === 'help')  { showHelp(); return true; }
    if (sub === 'status') return showStatus();

    if (sub === 'setup') {
      // Everything after "setup" is key=value pairs
      const setupArgs = parts.slice(1).join(' ');
      return runSetup(setupArgs);
    }

    if (sub === 'spec' || sub === 'specification') {
      const phase = parts[1];
      if (!phase) {
        const cfg = readConfig();
        const prd = readPrd(cfg);
        if (prd && prd.phases.length > 0) {
          console.log(chalk.red('Phase required. Available phases:'));
          prd.phases.forEach((p, i) => console.log(`  ${i + 1}. ${chalk.cyan(p)}`));
          console.log(chalk.dim('\nUsage: /orchestrate spec <phase> [--dry-run]'));
        } else {
          console.log(chalk.red('Phase required: /orchestrate spec <phase>'));
        }
        return true;
      }
      const flags = parts.slice(2);
      return runSpecification(phase, flags);
    }

    if (sub === 'estimate') {
      const phase = parts[1];
      if (!phase) {
        const cfg = readConfig();
        const prd = readPrd(cfg);
        if (prd && prd.phases.length > 0) {
          console.log(chalk.red('Phase required. Available phases:'));
          prd.phases.forEach((p, i) => console.log(`  ${i + 1}. ${chalk.cyan(p)}`));
          console.log(chalk.dim('\nUsage: /orchestrate estimate <phase>'));
        } else {
          console.log(chalk.red('Phase required: /orchestrate estimate <phase>'));
        }
        return true;
      }
      const flags = parts.slice(2); // e.g. --refine --apply --skip-cpa
      return runEstimate(phase, flags);
    }

    if (sub === 'execution' || sub === 'exec') {
      const phase = parts[1];
      if (!phase) {
        const cfg = readConfig();
        const prd = readPrd(cfg);
        if (prd && prd.phases.length > 0) {
          console.log(chalk.red('Phase required. Available phases:'));
          prd.phases.forEach((p, i) => console.log(`  ${i + 1}. ${chalk.cyan(p)}`));
          console.log(chalk.dim('\nUsage: /orchestrate execution <phase>'));
        } else {
          console.log(chalk.red('Phase required: /orchestrate execution <phase>'));
        }
        return true;
      }
      return launchExecution(phase);
    }

    console.log(chalk.red(`Unknown command: ${sub}`));
    showHelp();
    return true;
  },
};
