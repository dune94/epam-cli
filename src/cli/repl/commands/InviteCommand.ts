/**
 * /invite Slash Command
 * 
 * Invite users to team via EPAM backend API
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

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
    console.log(chalk.bold.cyan('📧 Sending Invitation'));
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
    
    console.log(chalk.bold('Invitation Details:'));
    console.log(`  Email: ${chalk.white(email)}`);
    console.log(`  Role: ${chalk.cyan(role)}`);
    console.log(`  Team: ${chalk.white('Current Team')}`);
    console.log();
    
    // In real implementation, call EPAM backend API
    console.log(chalk.yellow('⚠  Backend API Call Required'));
    console.log();
    console.log(chalk.bold('API Request:'));
    console.log(chalk.dim('  POST /api/teams/{teamId}/invitations'));
    console.log(chalk.dim('  Authorization: Bearer {token}'));
    console.log(chalk.dim('  Content-Type: application/json'));
    console.log();
    console.log(chalk.dim('  Payload:'));
    console.log(chalk.dim('  {'));
    console.log(chalk.dim(`    "email": "${email}",`));
    console.log(chalk.dim(`    "role": "${role}",`));
    console.log(chalk.dim('    "message": "You\'ve been invited to join our team"'));
    console.log(chalk.dim('  }'));
    console.log();
    
    console.log(chalk.bold('Expected Response:'));
    console.log(chalk.dim('  {'));
    console.log(chalk.dim('    "invitationId": "inv_123456",'));
    console.log(chalk.dim('    "status": "pending",'));
    console.log(chalk.dim('    "expiresAt": "2024-01-15T00:00:00Z"'));
    console.log(chalk.dim('  }'));
    console.log();
    
    console.log(chalk.green('✓ Invitation would be sent'));
    console.log(chalk.dim('  Email notification sent to ' + email));
    console.log(chalk.dim('  Invitation expires in 7 days'));
    console.log();
    
    console.log(chalk.dim('Tip: Use /members to see pending invitations'));
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
