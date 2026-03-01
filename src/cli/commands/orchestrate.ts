import { Command } from 'commander';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

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

export function createOrchestrateCommand(): Command {
  return new Command('orchestrate')
    .description('Run multi-agent orchestration for a project phase')
    .option('--phase <id>', 'Phase to execute (default: finops)')
    .option('--mode <mode>', 'Orchestration mode: bash or hybrid', 'bash')
    .option('--dry-run', 'Preview execution plan without running agents')
    .option('--skip-cleanup', 'Keep git worktrees after execution (for debugging)')
    .option('--skip-cpa', 'Skip the CPA pre-pass estimate gate')
    .option('--strict-cpa', 'Halt orchestration on CPA review gates')
    .action(async (opts) => {
      const ORCHESTRATION_SCRIPT = resolve(
        process.cwd(), 'orchestrations/scripts/run-agent-orchestration.sh',
      );

      if (!existsSync(ORCHESTRATION_SCRIPT)) {
        process.stderr.write(`Error: run-agent-orchestration.sh not found at ${ORCHESTRATION_SCRIPT}\n`);
        process.stderr.write('Make sure you are running from the epam-cli project root.\n');
        process.exit(1);
      }

      if (opts.mode && !['bash', 'hybrid'].includes(opts.mode)) {
        process.stderr.write(`Error: --mode must be "bash" or "hybrid" (got "${opts.mode}")\n`);
        process.exit(1);
      }

      const args: string[] = [];
      if (opts.phase) args.push('--phase', opts.phase);
      if (opts.mode) args.push('--mode', opts.mode);
      if (opts.dryRun) args.push('--dry-run');
      if (opts.skipCleanup) args.push('--skip-cleanup');

      const env: Record<string, string> = {};
      if (opts.skipCpa) env.SKIP_CPA = '1';
      if (opts.strictCpa) env.STRICT_CPA = '1';

      const code = await runScript(ORCHESTRATION_SCRIPT, args, env);

      if (code === 2) {
        process.stderr.write('\nOrchestration halted: escalated stories require human review.\n');
      } else if (code === 3) {
        process.stderr.write('\nOrchestration halted: CPA gate blocked one or more stories.\n');
      } else if (code !== 0) {
        process.stderr.write(`\nOrchestration failed (exit ${code}).\n`);
      }

      process.exit(code);
    });
}

export interface OrchestrateOptions {
  phase?: string;
  dryRun?: boolean;
  skipCpa?: boolean;
  strictCpa?: boolean;
  logFile?: string;
}

export interface OrchestrateResult {
  code: number;
  message?: string;
}

export async function executeOrchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const { createWriteStream } = await import('fs');
  const ORCHESTRATION_SCRIPT = resolve(
    process.cwd(), 'orchestrations/scripts/run-agent-orchestration.sh',
  );

  if (!existsSync(ORCHESTRATION_SCRIPT)) {
    return { code: 1, message: `run-agent-orchestration.sh not found at ${ORCHESTRATION_SCRIPT}` };
  }

  const logStream = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;

  const runScriptToResult = (script: string, args: string[], env?: Record<string, string>): Promise<number> =>
    new Promise((res, reject) => {
      const child = spawn('bash', [script, ...args], {
        stdio: logStream ? ['inherit', logStream, logStream] as const : 'inherit',
        env: { ...process.env, ...env },
      });
      child.on('error', reject);
      child.on('close', code => res(code ?? 1));
    });

  const args: string[] = [];
  if (opts.phase) args.push('--phase', opts.phase);
  if (opts.dryRun) args.push('--dry-run');

  const env: Record<string, string> = {};
  if (opts.skipCpa) env.SKIP_CPA = '1';
  if (opts.strictCpa) env.STRICT_CPA = '1';

  const code = await runScriptToResult(ORCHESTRATION_SCRIPT, args, env);
  const messages: Record<number, string> = {
    2: 'Orchestration halted: escalated stories require human review.',
    3: 'Orchestration halted: CPA gate blocked one or more stories.',
  };
  return { code, message: code !== 0 ? (messages[code] ?? `Orchestration failed (exit ${code})`) : undefined };
}
