/**
 * /orchestrate Slash Command
 *
 * Subcommands:
 *   /orchestrate              — interactive wizard (phase picker + action menu)
 *   /orchestrate setup        — configure defaults saved to .epam/orchestration.json
 *   /orchestrate estimate     — run estimate-stories.sh + CPA pass for a phase
 *   /orchestrate spec         — run specification elaboration pipeline (openspec/speckit/coordinator)
 *   /orchestrate execution    — launch run-agent-orchestration.sh (detached)
 *   /orchestrate status       — show progress of last launched run
 *   /orchestrate help         — show help
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

// ── readline helpers ────────────────────────────────────────────────────────

function ask(rl: import('readline').Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function pickFromList(
  rl: import('readline').Interface,
  prompt: string,
  items: string[],
  defaultIdx = 0,
): Promise<string | null> {
  console.log();
  items.forEach((item, i) => {
    const marker = i === defaultIdx ? chalk.green('❯') : ' ';
    console.log(`  ${marker} ${chalk.bold(String(i + 1))}. ${chalk.cyan(item)}`);
  });
  console.log();
  const answer = await ask(rl, chalk.cyan(`${prompt} [1-${items.length}] (Enter = ${defaultIdx + 1}): `));
  if (!answer) return items[defaultIdx];
  const n = parseInt(answer, 10);
  return n >= 1 && n <= items.length ? items[n - 1] : null;
}

// ── Script runner ────────────────────────────────────────────────────────────

function runScript(script: string, args: string[], env?: Record<string, string>): Promise<number> {
  return runCommand('bash', [script, ...args], env);
}

function runCommand(cmd: string, args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise((res, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('close', code => res(code ?? 1));
  });
}

// ── setup wizard ────────────────────────────────────────────────────────────

async function runSetupWizard(ctx: SlashCommandContext): Promise<boolean> {
  const rl = ctx.rl;
  if (!rl) {
    console.log(chalk.red('Interactive setup requires a TTY session.'));
    return true;
  }

  const existing = readConfig();

  console.log();
  console.log(chalk.bold.cyan('⚙️  Orchestration Setup'));
  console.log(chalk.dim('  Saves defaults to .epam/orchestration.json'));
  console.log(chalk.dim('  Press Enter to keep current value.'));
  console.log();

  // Provider
  const providerList = Object.keys(readProviders());
  const providerDefault = providerList.indexOf(existing.provider ?? 'claude');
  console.log(chalk.bold('Provider:') + chalk.dim(` (current: ${existing.provider ?? 'claude'})`));
  const provider = await pickFromList(rl, 'Select provider', providerList, providerDefault < 0 ? 0 : providerDefault);
  if (!provider) { console.log(chalk.yellow('Setup cancelled.')); return true; }

  // Mode
  const modes = ['bash', 'hybrid'];
  const modeDefault = modes.indexOf(existing.mode ?? 'bash');
  console.log(chalk.bold('Mode:') + chalk.dim(` (current: ${existing.mode ?? 'bash'})`));
  const mode = await pickFromList(rl, 'Select mode', modes, modeDefault < 0 ? 0 : modeDefault) as 'bash' | 'hybrid';
  if (!mode) { console.log(chalk.yellow('Setup cancelled.')); return true; }

  // PRD path
  const prdAnswer = await ask(
    rl,
    chalk.cyan(`PRD file path [${existing.prdFile ?? 'orchestrations/prd.json'}]: `),
  );
  const prdFile = prdAnswer || existing.prdFile || 'orchestrations/prd.json';

  // Output dir
  const outputAnswer = await ask(
    rl,
    chalk.cyan(`Output dir [${existing.outputDir ?? 'orchestrations/logs'}]: `),
  );
  const outputDir = outputAnswer || existing.outputDir || 'orchestrations/logs';

  // Flags
  const skipCpaAnswer = await ask(
    rl,
    chalk.cyan(`Skip CPA gate? [${existing.skipCpa ? 'Y/n' : 'y/N'}]: `),
  );
  const skipCpa = skipCpaAnswer ? /^y/i.test(skipCpaAnswer) : (existing.skipCpa ?? false);

  const strictCpaAnswer = await ask(
    rl,
    chalk.cyan(`Strict CPA (halt on review)? [${existing.strictCpa ? 'Y/n' : 'y/N'}]: `),
  );
  const strictCpa = strictCpaAnswer ? /^y/i.test(strictCpaAnswer) : (existing.strictCpa ?? false);

  const worktreeAnswer = await ask(
    rl,
    chalk.cyan(`Enable git worktrees for parallel execution? [${existing.worktree ? 'Y/n' : 'y/N'}]: `),
  );
  const worktree = worktreeAnswer ? /^y/i.test(worktreeAnswer) : (existing.worktree ?? false);

  const cfg: OrchestrationConfig = { provider, mode, prdFile, outputDir, skipCpa, strictCpa, worktree };
  writeConfig(cfg);

  console.log();
  console.log(chalk.green('✓ Saved to .epam/orchestration.json'));
  console.log();
  console.log(chalk.dim(`  provider:   ${provider}`));
  console.log(chalk.dim(`  mode:       ${mode}`));
  console.log(chalk.dim(`  prd:        ${prdFile}`));
  console.log(chalk.dim(`  output-dir: ${outputDir}`));
  console.log(chalk.dim(`  skip-cpa:   ${skipCpa}`));
  console.log(chalk.dim(`  strict-cpa: ${strictCpa}`));
  console.log(chalk.dim(`  worktree:   ${worktree}`));
  console.log();
  return true;
}

// ── estimate ────────────────────────────────────────────────────────────────

async function runEstimate(phase: string, ctx: SlashCommandContext): Promise<boolean> {
  const cfg = readConfig();
  const rl = ctx.rl;

  const estimateScript = join(process.cwd(), 'orchestrations', 'scripts', 'estimate-stories.sh');
  const cpaScript      = join(process.cwd(), 'orchestrations', 'scripts', 'contextualize-stories.sh');

  if (!existsSync(estimateScript)) {
    console.log(chalk.red('Error: estimate-stories.sh not found.'));
    console.log(chalk.dim('Run from the epam-cli project root.'));
    return true;
  }

  // Ask --refine and --apply via wizard if TTY
  let doRefine = false;
  let doApply  = false;
  let skipCpa  = cfg.skipCpa ?? false;

  if (rl) {
    console.log();
    const refineAnswer = await ask(rl, chalk.cyan('Calibrate from historical actuals (--refine)? [y/N]: '));
    doRefine = /^y/i.test(refineAnswer);

    const applyAnswer = await ask(rl, chalk.cyan('Write estimates back to prd.json (--apply)? [y/N]: '));
    doApply = /^y/i.test(applyAnswer);

    const skipCpaAnswer = await ask(rl, chalk.cyan(`Skip CPA pass? [${skipCpa ? 'Y/n' : 'y/N'}]: `));
    skipCpa = skipCpaAnswer ? /^y/i.test(skipCpaAnswer) : skipCpa;
  }

  console.log();
  console.log(chalk.bold.cyan(`📊 Estimating phase: ${phase}`));
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
    console.log(chalk.bold.cyan('🔍 Running CPA contextualisation pass...'));
    console.log();
    const cpaArgs = ['--phase', phase];
    if (doApply) cpaArgs.push('--apply');
    if (cfg.strictCpa) cpaArgs.push('--strict');
    const cpaCode = await runScript(cpaScript, cpaArgs, env);
    if (cpaCode === 3) {
      console.log(chalk.red('\n⛔ CPA gate: BLOCKED — resolve flagged issues before executing.'));
    } else if (cpaCode === 2) {
      console.log(chalk.yellow('\n⚠️  CPA gate: REVIEW — some stories have elevated risk.'));
    }
  }

  return true;
}

// ── spec ─────────────────────────────────────────────────────────────────────

async function runSpec(phase: string, ctx: SlashCommandContext): Promise<boolean> {
  const cfg = readConfig();
  const rl = ctx.rl;

  const nodeCmd = process.env.NODE_CMD ?? join(process.env.HOME ?? '', '.nvm/versions/node/v20.20.0/bin/node');
  const specRunner = join(process.cwd(), 'orchestrations', 'scripts', 'spec-mode-runner.js');

  if (!existsSync(specRunner)) {
    console.log(chalk.red('Error: spec-mode-runner.js not found.'));
    console.log(chalk.dim(`Expected: ${specRunner}`));
    return true;
  }

  let dryRun = false;
  if (rl) {
    console.log();
    const dryRunAnswer = await ask(rl, chalk.cyan('Dry run (evaluate assignments without applying PRD changes)? [y/N]: '));
    dryRun = /^y/i.test(dryRunAnswer);
  }

  console.log();
  console.log(chalk.bold.cyan(`📝 Running specification pass: ${phase}`));
  if (dryRun) console.log(chalk.dim('  (dry-run mode — no PRD changes will be applied)'));
  console.log();

  const env: Record<string, string> = {};
  if (cfg.prdFile) env.PRD_FILE = resolve(process.cwd(), cfg.prdFile);
  if (cfg.outputDir) env.OUTPUT_DIR = resolve(process.cwd(), cfg.outputDir);

  const specArgs = [specRunner, '--phase', phase];
  if (dryRun) specArgs.push('--dry-run');

  const code = await runCommand(nodeCmd, specArgs, env);
  if (code !== 0) {
    console.log(chalk.red(`\nSpecification pass failed (exit ${code})`));
  } else {
    console.log(chalk.green('\n✓ Specification pass complete'));
  }

  return true;
}

// ── execution ────────────────────────────────────────────────────────────────

async function launchExecution(phase: string, ctx: SlashCommandContext): Promise<boolean> {
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
  console.log(chalk.bold.green(`🚀 Launching orchestration`));
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

    console.log(chalk.green(`✓ Started (PID ${pid})`));
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

async function showStatus(_ctx: SlashCommandContext): Promise<boolean> {
  const stateFile = join(process.cwd(), STATE_FILE);

  console.log();
  console.log(chalk.bold.cyan('📊 Orchestration Status'));
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
    console.log(`  Status:   ${chalk.green('✓ Completed')}`);
    console.log();
    return true;
  }

  console.log(`  Status:   ${chalk.yellow('⟳ Running')} (PID ${state.pid})`);

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

// ── interactive wizard (no-args) ─────────────────────────────────────────────

async function runWizard(ctx: SlashCommandContext): Promise<boolean> {
  const rl = ctx.rl;
  if (!rl) {
    showHelp();
    return true;
  }

  const cfg  = readConfig();
  const prd  = readPrd(cfg);
  const hasConfig = existsSync(join(process.cwd(), CONFIG_FILE));

  console.log();
  console.log(chalk.bold.cyan('🤖 Orchestration'));
  if (!hasConfig) {
    console.log(chalk.yellow('  ⚠  No config found — run /orchestrate setup first'));
  }
  console.log();

  // Action menu
  const actions = ['estimate', 'spec', 'execution', 'status', 'setup'];
  const action = await pickFromList(rl, 'What do you want to do', actions, 0);
  if (!action) return true;

  if (action === 'status') return showStatus(ctx);
  if (action === 'setup')  return runSetupWizard(ctx);

  // Phase picker
  if (!prd || prd.phases.length === 0) {
    console.log(chalk.red('\nNo phases found in prd.json.'));
    console.log(chalk.dim('Check your PRD file path in /orchestrate setup.'));
    return true;
  }

  const phase = await pickFromList(rl, 'Select phase', prd.phases, 0);
  if (!phase) return true;

  if (action === 'estimate')  return runEstimate(phase, ctx);
  if (action === 'spec')      return runSpec(phase, ctx);
  if (action === 'execution') return launchExecution(phase, ctx);

  return true;
}

// ── help ─────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log();
  console.log(chalk.bold('Orchestration Commands:'));
  console.log();
  console.log(`  ${chalk.cyan('/orchestrate')}               ${chalk.dim('Interactive wizard (phase picker + action menu)')}`);
  console.log(`  ${chalk.cyan('/orchestrate setup')}         ${chalk.dim('Configure provider, mode, paths, flags')}`);
  console.log(`  ${chalk.cyan('/orchestrate estimate')} ${chalk.dim('<phase>')}  ${chalk.dim('Run estimation + CPA pass')}`);
  console.log(`  ${chalk.cyan('/orchestrate spec')} ${chalk.dim('<phase>')}      ${chalk.dim('Run specification elaboration (openspec/speckit)')}`);
  console.log(`  ${chalk.cyan('/orchestrate execution')} ${chalk.dim('<phase>')} ${chalk.dim('Launch orchestration (detached)')}`);
  console.log(`  ${chalk.cyan('/orchestrate status')}        ${chalk.dim('Show progress of last run')}`);
  console.log();
  console.log(chalk.dim('Config persisted in .epam/orchestration.json'));
  console.log(chalk.dim('Override with /orchestrate setup'));
  console.log();
}

// ── entry point ──────────────────────────────────────────────────────────────

export const orchestrateCommand: SlashCommand = {
  name: 'orchestrate',
  aliases: ['orch'],
  description: 'Launch and monitor multi-agent orchestration',
  usage: '[setup | estimate <phase> | spec <phase> | execution <phase> | status | help]',

  async execute(args, ctx): Promise<boolean> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub   = parts[0]?.toLowerCase();
    const phase = parts[1];

    if (!sub)                                    return runWizard(ctx);
    if (sub === 'setup')                         return runSetupWizard(ctx);
    if (sub === 'status')                        return showStatus(ctx);
    if (sub === 'help')                          { showHelp(); return true; }

    if (sub === 'estimate') {
      if (!phase) {
        // Phase picker via wizard
        const cfg = readConfig();
        const prd = readPrd(cfg);
        if (!prd || prd.phases.length === 0) {
          console.log(chalk.red('Phase required: /orchestrate estimate <phase>'));
          return true;
        }
        const rl = ctx.rl;
        if (!rl) { console.log(chalk.red('Phase required: /orchestrate estimate <phase>')); return true; }
        const picked = await pickFromList(rl, 'Select phase', prd.phases, 0);
        if (!picked) return true;
        return runEstimate(picked, ctx);
      }
      return runEstimate(phase, ctx);
    }

    if (sub === 'spec') {
      if (!phase) {
        const cfg = readConfig();
        const prd = readPrd(cfg);
        if (!prd || prd.phases.length === 0) {
          console.log(chalk.red('Phase required: /orchestrate spec <phase>'));
          return true;
        }
        const rl = ctx.rl;
        if (!rl) { console.log(chalk.red('Phase required: /orchestrate spec <phase>')); return true; }
        const picked = await pickFromList(rl, 'Select phase', prd.phases, 0);
        if (!picked) return true;
        return runSpec(picked, ctx);
      }
      return runSpec(phase, ctx);
    }

    if (sub === 'execution' || sub === 'exec') {
      if (!phase) {
        const cfg = readConfig();
        const prd = readPrd(cfg);
        if (!prd || prd.phases.length === 0) {
          console.log(chalk.red('Phase required: /orchestrate execution <phase>'));
          return true;
        }
        const rl = ctx.rl;
        if (!rl) { console.log(chalk.red('Phase required: /orchestrate execution <phase>')); return true; }
        const picked = await pickFromList(rl, 'Select phase', prd.phases, 0);
        if (!picked) return true;
        return launchExecution(picked, ctx);
      }
      return launchExecution(phase, ctx);
    }

    console.log(chalk.red(`Unknown command: ${sub}`));
    showHelp();
    return true;
  },
};
