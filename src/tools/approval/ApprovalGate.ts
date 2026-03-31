import chalk from 'chalk';
import prompts from 'prompts';
import { requiresApproval } from './SafetyPolicy.js';
import type { ToolPermission } from '../types.js';

const sessionAlwaysAllow = new Set<string>();
const sessionNeverAllow = new Set<string>();

export async function requestApproval(
  toolName: string,
  input: Record<string, unknown>,
  permission: ToolPermission,
  dangerousSkipApproval: boolean
): Promise<boolean> {
  if (!requiresApproval(toolName, permission, dangerousSkipApproval)) {
    return true;
  }

  if (sessionAlwaysAllow.has(toolName)) return true;
  if (sessionNeverAllow.has(toolName)) return false;

  const inputPreview = JSON.stringify(input, null, 2).split('\n').slice(0, 10).join('\n');

  console.log(
    chalk.yellow.bold('\n⚠ Tool Approval Required') +
    chalk.dim(` [${permission}]`)
  );
  console.log(chalk.bold(`Tool:`), chalk.cyan(toolName));
  console.log(chalk.bold(`Input:`), chalk.dim(inputPreview));

  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'Allow this tool call?',
    choices: [
      { title: 'Yes, once', value: 'yes' },
      { title: 'Yes, always (this session)', value: 'always' },
      { title: 'No, skip', value: 'no' },
      { title: 'No, never (this session)', value: 'never' },
    ],
    initial: 0,
  });

  if (!response.action || response.action === 'no') return false;
  if (response.action === 'never') {
    sessionNeverAllow.add(toolName);
    return false;
  }
  if (response.action === 'always') {
    sessionAlwaysAllow.add(toolName);
  }
  return true;
}

export function resetApprovalSession(): void {
  sessionAlwaysAllow.clear();
  sessionNeverAllow.clear();
}
