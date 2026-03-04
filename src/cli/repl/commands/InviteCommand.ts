/**
 * /invite Slash Command
 * 
 * Invite users to team via EPAM backend API
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { ulid } from 'ulid';
import { readTeamConfig, writeTeamConfig } from './TeamCommand.js';

export const inviteCommand: SlashCommand = {
  name: 'invite',
  aliases: ['invite-member'],
  description: 'Invite users to team via EPAM backend API',
  usage: '<email> [role]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim();
    
    if (!trimmedArgs) {
      console.log();
      console.log(chalk.bold.cyan('📧 Invite Team Member'));
      console.log();
      console.log(chalk.dim('Usage: /invite <email> [role]'));
      console.log();
      console.log(chalk.bold('Roles:'));
      console.log(`  ${chalk.cyan('member')}  - Standard member (default)`);
      console.log(`  ${chalk.cyan('viewer')}  - Read-only access`);
      console.log(`  ${chalk.cyan('admin')}   - Admin privileges`);
      console.log();
      console.log(chalk.bold('Example:'));
      console.log(chalk.dim('  /invite john@example.com'));
      console.log(chalk.dim('  /invite jane@example.com admin'));
      console.log();
      return true;
    }
    
    const parts = trimmedArgs.split(/\s+/);
    const email = parts[0];
    const role = parts[1] || 'member';

    console.log();
    console.log(chalk.bold.cyan('📧 Inviting Team Member'));
    console.log();

    // Validate email
    if (!isValidEmail(email)) {
      console.log(chalk.red(`Invalid email: ${email}`));
      console.log();
      return true;
    }

    // Validate role
    const validRoles = ['member', 'viewer', 'admin'];
    if (!validRoles.includes(role)) {
      console.log(chalk.red(`Invalid role: ${role}`));
      console.log(chalk.dim(`Valid roles: ${validRoles.join(', ')}`));
      console.log();
      return true;
    }

    const projectRoot = ctx.config.projectRoot || process.cwd();
    const team = readTeamConfig(projectRoot);

    if (!team) {
      console.log(chalk.red('No team configured. Run /team init <name> first.'));
      console.log();
      return true;
    }

    // Check for duplicate
    if (team.members.some(m => m.email === email)) {
      console.log(chalk.yellow(`⚠  ${email} is already a team member`));
      console.log();
      return true;
    }

    const newMember = {
      id: ulid(),
      name: email.split('@')[0],
      email,
      role: role as 'member' | 'viewer' | 'admin',
      status: 'pending' as const,
      lastActive: new Date().toISOString(),
    };

    team.members.push(newMember);
    writeTeamConfig(projectRoot, team);

    console.log(chalk.green(`✓ ${email} added to team "${team.name}"`));
    console.log(`  Role: ${chalk.cyan(role)}`);
    console.log(`  Status: ${chalk.dim('pending')}`);
    console.log();
    console.log(chalk.dim('Use /members to view all team members'));
    console.log();

    return true;
  },
};

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
