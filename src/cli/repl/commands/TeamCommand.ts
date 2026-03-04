/**
 * /team Slash Command
 * 
 * Show team overview and status
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { ulid } from 'ulid';

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
  status: 'online' | 'offline' | 'busy' | 'pending';
  lastActive?: string;
}

export function readTeamConfig(projectRoot: string): TeamConfig | null {
  const teamConfigPath = join(projectRoot, '.epam', 'team.json');
  if (!existsSync(teamConfigPath)) return null;
  try {
    return JSON.parse(readFileSync(teamConfigPath, 'utf-8')) as TeamConfig;
  } catch {
    return null;
  }
}

export function writeTeamConfig(projectRoot: string, team: TeamConfig): void {
  const teamConfigPath = join(projectRoot, '.epam', 'team.json');
  mkdirSync(dirname(teamConfigPath), { recursive: true });
  writeFileSync(teamConfigPath, JSON.stringify(team, null, 2), 'utf-8');
}

export const teamCommand: SlashCommand = {
  name: 'team',
  aliases: ['team-info'],
  description: 'Show team overview and status',
  usage: '[init <name>]',

  async execute(args, ctx): Promise<boolean> {
    const trimmed = args.trim();

    // /team init <name>
    if (trimmed.startsWith('init')) {
      const name = trimmed.replace(/^init\s*/, '').trim();
      if (!name) {
        console.log();
        console.log(chalk.red('Team name required'));
        console.log(chalk.dim('Usage: /team init <name>'));
        console.log();
        return true;
      }
      return initTeam(name, ctx);
    }

    const teamConfigPath = join(process.cwd(), '.epam', 'team.json');
    
    console.log();
    console.log(chalk.bold.cyan('👥 Team Overview'));
    console.log();

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

function initTeam(name: string, ctx: SlashCommandContext): boolean {
  const projectRoot = ctx.config.projectRoot || process.cwd();
  const existing = readTeamConfig(projectRoot);
  if (existing) {
    console.log();
    console.log(chalk.yellow(`⚠  Team "${existing.name}" already exists`));
    console.log(chalk.dim('Use /team to view it, or edit .epam/team.json directly.'));
    console.log();
    return true;
  }

  const ownerEmail = process.env.EPAM_USER_EMAIL || process.env.USER || 'owner@local';
  const ownerName = process.env.EPAM_USER_NAME || ownerEmail.split('@')[0];

  const team: TeamConfig = {
    name,
    members: [
      {
        id: ulid(),
        name: ownerName,
        email: ownerEmail,
        role: 'owner',
        status: 'online',
        lastActive: new Date().toISOString(),
      },
    ],
    sharedSessions: [],
  };

  writeTeamConfig(projectRoot, team);

  console.log();
  console.log(chalk.bold.green(`✓ Team "${name}" created`));
  console.log();
  console.log(chalk.bold('Owner:'));
  console.log(`  ${chalk.white(ownerName)} ${chalk.dim(`<${ownerEmail}>`)}`);
  console.log();
  console.log(chalk.bold('Next Steps:'));
  console.log(`  ${chalk.cyan('/invite <email>')}  - Invite team members`);
  console.log(`  ${chalk.cyan('/members')}         - View all members`);
  console.log(`  ${chalk.cyan('/share')}            - Share your session`);
  console.log();
  return true;
}
