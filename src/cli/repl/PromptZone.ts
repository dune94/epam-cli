/**
 * PromptZone — renders the header bar + separators above the readline prompt.
 *
 * Layout per turn (after first):
 *
 *   ─────────────────────────────────────  ← gray separator (between response and header)
 *
 *   folder [branch]          model · N turns
 *   ─────────────────────────────────────  ← dim separator (above epam ›)
 *   epam ›
 */

import chalk from 'chalk';
import * as path from 'path';
import { execSync } from 'child_process';

export interface PromptZoneState {
  provider: string;
  model: string;
  turns: number;
  sessionCost?: number;
  hardLimitAt?: number;
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

export function buildPromptZoneLines(state: PromptZoneState, cols: number): string[] {
  const folder = path.basename(process.cwd());
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).toString().trim();
  } catch { /* not a git repo */ }

  const leftLabel = branch
    ? chalk.bold(folder) + chalk.dim(` [${branch}]`)
    : chalk.bold(folder);

  const modelTag = chalk.greenBright(`${state.provider}/${state.model}`);
  let rightLabel: string;
  if (state.hardLimitAt && isFinite(state.hardLimitAt) && state.hardLimitAt > 0) {
    const cost = state.sessionCost ?? 0;
    const pct = Math.max(0, ((state.hardLimitAt - cost) / state.hardLimitAt) * 100).toFixed(1);
    rightLabel = modelTag + chalk.dim(` · `) + chalk.cyan(`${pct}% remaining`);
  } else {
    const t = state.turns;
    rightLabel = modelTag + chalk.dim(` · ${t} turn${t !== 1 ? 's' : ''}`);
  }

  const gap = Math.max(1, cols - stripAnsi(leftLabel).length - stripAnsi(rightLabel).length);
  const header = leftLabel + ' '.repeat(gap) + rightLabel;
  const dimSep = chalk.dim('─'.repeat(cols));

  // Layout: [blank] header dimSep
  // The gray separator between turns is printed by PromptZone.render() before this.
  return ['', header, dimSep];
}

export class PromptZone {
  private isFirst = true;
  private readonly out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
  }

  render(state: PromptZoneState): void {
    const cols = this.out.columns || 80;
    if (!this.isFirst) {
      // Gray separator between previous response and this prompt
      this.out.write('\n' + chalk.gray('─'.repeat(cols)) + '\n');
    }
    this.isFirst = false;
    const lines = buildPromptZoneLines(state, cols);
    this.out.write(lines.join('\n') + '\n');
  }

  reset(): void {
    this.isFirst = true;
  }
}
