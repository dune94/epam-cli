/**
 * /team Slash Command
 * 
 * Show team overview and status
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface TeamConfig {
  name: string;
  members: TeamMember[];
  sharedSessions: string[];
}

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: 'online' | 'offline' | 'busy';
  lastActive?: string;
}

export const teamCommand: SlashCommand = {
  name: 'team',
  aliases: ['team-info'],
  description: 'Show team overview and status',
  
  async execute(_args, ctx): Promise<boolean> {
    console.log();
    console.log(chalk.bold.cyan('👥 Team Overview'));
    console.log();
    
    const teamConfigPath = join(process.cwd(), '.epam', 'team.json');
    
    if (!existsSync(teamConfigPath)) {
      console.log(chalk.dim('No team configured'));
      console.log();
      console.log(chalk.bold('Quick Start:'));
      console.log(`  1. ${chalk.cyan('/team init <name>')} - Create team`);
      console.log(`  2. ${chalk.cyan('/invite <email>')} - Invite members`);
      console.log(`  3. ${chalk.cyan('/share <session>')} - Share sessions`);
      console.log();
      return true;
    }
    
    try {
      const team: TeamConfig = JSON.parse(readFileSync(teamConfigPath, 'utf-8'));
      
      console.log(chalk.bold(`Team: ${chalk.white(team.name)}`));
      console.log();
      
      // Members summary
      const onlineCount = team.members.filter(m => m.status === 'online').length;
      console.log(chalk.bold('Members:'));
      console.log(`  Total: ${chalk.white(team.members.length)}`);
      console.log(`  Online: ${chalk.green(onlineCount)}`);
      console.log(`  Offline: ${chalk.dim(team.members.length - onlineCount)}`);
      console.log();
      
      // Shared sessions
      console.log(chalk.bold('Shared Sessions:'));
      if (team.sharedSessions.length === 0) {
        console.log(chalk.dim('  No shared sessions'));
      } else {
        for (const session of team.sharedSessions.slice(0, 5)) {
          console.log(`  • ${chalk.cyan(session)}`);
        }
        if (team.sharedSessions.length > 5) {
          console.log(chalk.dim(`  ... and ${team.sharedSessions.length - 5} more`));
        }
      }
      console.log();
      
      // Quick actions
      console.log(chalk.bold('Quick Actions:'));
      console.log(`  ${chalk.cyan('/members')}        - List all members`);
      console.log(`  ${chalk.cyan('/invite <email>')}  - Invite new member`);
      console.log(`  ${chalk.cyan('/share <id>')}      - Share session`);
      console.log(`  ${chalk.cyan('/handoff <user>')}  - Handoff session`);
      console.log();
      
    } catch (err) {
      console.log(chalk.red('Error reading team config'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }
    
    return true;
  },
};
