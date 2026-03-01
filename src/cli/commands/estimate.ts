import { Command } from 'commander';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

function scriptsDir(): string {
  return resolve(process.cwd(), 'orchestrations/scripts');
}

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

export function createEstimateCommand(): Command {
  return new Command('estimate')
    .description('Estimate AI execution cost, tokens, and time for stories in prd.json')
    .option('--phase <id>', 'Scope to a single phase')
    .option('--apply', 'Write estimates back to prd.json')
    .option('--refine', 'Calibrate formula constants from historical actuals')
    .option('--dry-run', 'Run inference but skip all writes')
    .option('--json', 'Output results as JSON')
    .option('--strict', 'Halt on CPA review gates (default: halt only on block)')
    .option('--skip-cpa', 'Skip the CPA contextualisation pass (formula only)')
    .option('--reconcile', 'Compare prior CPA estimates against actuals')
    .action(async (opts) => {
      const ESTIMATE_SCRIPT = resolve(scriptsDir(), 'estimate-stories.sh');
      const CPA_SCRIPT = resolve(scriptsDir(), 'contextualize-stories.sh');

      if (!existsSync(ESTIMATE_SCRIPT)) {
        process.stderr.write(`Error: estimate-stories.sh not found at ${ESTIMATE_SCRIPT}\n`);
        process.stderr.write('Make sure you are running from the epam-cli project root.\n');
        process.exit(1);
      }

      // ── Reconcile mode (CPA only) ─────────────────────────────────────
      if (opts.reconcile) {
        if (!existsSync(CPA_SCRIPT)) {
          process.stderr.write(`Error: contextualize-stories.sh not found at ${CPA_SCRIPT}\n`);
          process.exit(1);
        }
        const cpaArgs = ['--reconcile'];
        if (opts.dryRun) cpaArgs.push('--dry-run');
        const code = await runScript(CPA_SCRIPT, cpaArgs);
        process.exit(code);
      }

      // ── Step 1: Formula estimation ─────────────────────────────────────
      const estArgs: string[] = [];
      if (opts.phase) estArgs.push('--phase', opts.phase);
      if (opts.refine) estArgs.push('--refine');
      if (opts.apply) estArgs.push('--apply');
      if (opts.json) estArgs.push('--json');

      if (!opts.apply && !opts.json) {
        // Default is dry-run display for the formula pass
      }

      const estCode = await runScript(ESTIMATE_SCRIPT, estArgs);
      if (estCode !== 0) {
        process.stderr.write(`Formula estimation failed (exit ${estCode})\n`);
        process.exit(estCode);
      }

      // ── Step 2: CPA contextualisation pass ─────────────────────────────
      if (opts.skipCpa) {
        if (!opts.json) {
          process.stderr.write('\nCPA pass skipped (--skip-cpa)\n');
        }
        process.exit(0);
      }

      if (!existsSync(CPA_SCRIPT)) {
        process.stderr.write('\nWarning: contextualize-stories.sh not found — skipping CPA pass\n');
        process.exit(0);
      }

      const cpaArgs: string[] = [];
      if (opts.phase) cpaArgs.push('--phase', opts.phase);
      if (opts.apply) cpaArgs.push('--apply');
      if (opts.strict) cpaArgs.push('--strict');
      if (opts.dryRun) cpaArgs.push('--dry-run');
      if (opts.json) cpaArgs.push('--json');

      const cpaCode = await runScript(CPA_SCRIPT, cpaArgs);

      if (cpaCode === 3) {
        process.stderr.write('\nCPA gate: BLOCKED — one or more stories cannot proceed.\n');
        process.stderr.write('Resolve flagged issues, then re-run. Override with --skip-cpa.\n');
      } else if (cpaCode === 2) {
        process.stderr.write('\nCPA gate: REVIEW — some stories have elevated risk.\n');
        if (!opts.strict) {
          process.stderr.write('Proceeding (use --strict to halt on review gates).\n');
        }
      }

      process.exit(cpaCode);
    });
}

export interface EstimateOptions {
  phase?: string;
  dryRun?: boolean;
  skipCpa?: boolean;
  strict?: boolean;
  logFile?: string;
}

export interface EstimateResult {
  code: number;
  cpa?: boolean;
  message?: string;
}

export async function executeEstimate(opts: EstimateOptions): Promise<EstimateResult> {
  const { createWriteStream } = await import('fs');
  const ESTIMATE_SCRIPT = resolve(scriptsDir(), 'estimate-stories.sh');
  const CPA_SCRIPT = resolve(scriptsDir(), 'contextualize-stories.sh');

  if (!existsSync(ESTIMATE_SCRIPT)) {
    return { code: 1, message: `estimate-stories.sh not found at ${ESTIMATE_SCRIPT}` };
  }

  const logStream = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;

  const runScriptToResult = (script: string, args: string[]): Promise<number> =>
    new Promise((res, reject) => {
      const child = logStream
        ? spawn('bash', [script, ...args], { stdio: ['inherit', logStream, logStream], env: process.env })
        : spawn('bash', [script, ...args], { stdio: 'inherit', env: process.env });
      child.on('error', reject);
      child.on('close', (code: number | null) => res(code ?? 1));
    });

  const estArgs: string[] = [];
  if (opts.phase) estArgs.push('--phase', opts.phase);
  if (opts.dryRun) estArgs.push('--dry-run');

  const estCode = await runScriptToResult(ESTIMATE_SCRIPT, estArgs);
  if (estCode !== 0) {
    return { code: estCode, message: `Formula estimation failed (exit ${estCode})` };
  }

  if (opts.skipCpa || !existsSync(CPA_SCRIPT)) {
    return { code: 0 };
  }

  const cpaArgs: string[] = [];
  if (opts.phase) cpaArgs.push('--phase', opts.phase);
  if (opts.strict) cpaArgs.push('--strict');
  if (opts.dryRun) cpaArgs.push('--dry-run');

  const cpaCode = await runScriptToResult(CPA_SCRIPT, cpaArgs);
  return { code: cpaCode, cpa: true, message: cpaCode !== 0 ? `CPA gate exit ${cpaCode}` : undefined };
}
