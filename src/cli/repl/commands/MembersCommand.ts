/**
 * /members Slash Command
 * 
 * List and manage team members
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: 'online' | 'offline' | 'busy';
  lastActive?: string;
}

export const membersCommand: SlashCommand = {
  name: 'members',
  aliases: ['team-members'],
  description: 'List and manage team members',
  usage: '[list|add|remove]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim().toLowerCase();
    
    if (!trimmedArgs || trimmedArgs === 'list') {
      return listMembers(ctx);
    }
    
    if (trimmedArgs.startsWith('add ') || trimmedArgs.startsWith('invite ')) {
      const email = trimmedArgs.split(' ')[1];
      if (!email) {
        console.log(chalk.red('Error: Email required'));
        console.log(chalk.dim('Usage: /members add <email>'));
        console.log();
        return true;
      }
      return inviteMember(email, ctx);
    }
    
    console.log(chalk.red(`Unknown members command: ${trimmedArgs}`));
    console.log(chalk.dim('Usage: /members [list|add <email>]'));
    console.log();
    
    return true;
  },
};

/**
 * List all team members
 */
function listMembers(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('👥 Team Members'));
  console.log();
  
  const teamConfigPath = join(process.cwd(), '.epam', 'team.json');
  
  if (!existsSync(teamConfigPath)) {
    console.log(chalk.dim('No team configured'));
    console.log(chalk.dim('Use /team init to create a team'));
    console.log();
    return true;
  }
  
  try {
    const team = JSON.parse(readFileSync(teamConfigPath, 'utf-8'));
    const members: TeamMember[] = team.members || [];
    
    if (members.length === 0) {
      console.log(chalk.dim('No members yet'));
      console.log();
      console.log(chalk.dim('Use /invite <email> to add members'));
      console.log();
      return true;
    }
    
    // Group by role
    const byRole: Record<string, TeamMember[]> = {
      owner: [],
      admin: [],
      member: [],
      viewer: [],
    };
    
    for (const member of members) {
      byRole[member.role]?.push(member);
    }
    
    // Display by role
    for (const [role, roleMembers] of Object.entries(byRole)) {
      if (roleMembers.length === 0) continue;
      
      const roleIcon = role === 'owner' ? '👑' :
                       role === 'admin' ? '⚙️' :
                       role === 'member' ? '👤' : '👁️';
      
      console.log(chalk.bold(`${roleIcon} ${role.charAt(0).toUpperCase() + role.slice(1)}s:`));
      console.log();
      
      for (const member of roleMembers) {
        const statusIcon = member.status === 'online' ? chalk.green('●') :
                          member.status === 'busy' ? chalk.yellow('●') :
                          chalk.dim('○');
        
        console.log(`  ${statusIcon} ${chalk.white(member.name)}`);
        console.log(chalk.dim(`     ${member.email}`));
        if (member.lastActive) {
          console.log(chalk.dim(`     Last active: ${member.lastActive}`));
        }
        console.log();
      }
    }
    
    console.log(chalk.dim(`Total: ${members.length} members`));
    console.log();
    
  } catch (err) {
    console.log(chalk.red('Error reading team config'));
    console.log(chalk.dim((err as Error).message));
    console.log();
  }
  
  return true;
}

/**
 * Invite a new member
 */
function inviteMember(email: string, ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('📧 Invite Member'));
  console.log();
  
  console.log(chalk.bold(`Inviting: ${chalk.white(email)}`));
  console.log();
  
  // In real implementation, this would call EPAM backend API
  console.log(chalk.yellow('⚠  Backend integration required'));
  console.log();
  console.log(chalk.dim('This command would:'));
  console.log(chalk.dim('  1. Call EPAM backend API to send invitation'));
  console.log(chalk.dim('  2. Create pending member record'));
  console.log(chalk.dim('  3. Send email notification'));
  console.log();
  console.log(chalk.dim('API Endpoint: POST /api/teams/{teamId}/members/invite'));
  console.log(chalk.dim('Payload: { email, role: "member" }'));
  console.log();
  
  return true;
}
