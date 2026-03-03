/**
 * /dashboard Slash Command
 * 
 * Open dashboard URLs in browser
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { execa } from 'execa';

const DASHBOARDS = {
  monitor: 'http://localhost:8092/monitor.html',
  prd: 'http://localhost:8092/prd-viewer.html',
  cost: 'http://localhost:8092/phase-cost-monitor.html',
  agents: 'http://localhost:8092/agent-profiles.html',
  orchestration: 'http://localhost:8092/orchestration-plan.html',
} as const;

export const dashboardCommand: SlashCommand = {
  name: 'dashboard',
  aliases: ['dash', 'dashboards'],
  description: 'Open dashboard URLs in browser',
  usage: '[monitor|prd|cost|agents|orchestration|all]',
  
  async execute(args, ctx): Promise<boolean> {
    const dashboardName = args.trim().toLowerCase() || 'all';
    
    console.log();
    console.log(chalk.bold.cyan('📊 Dashboards'));
    console.log();
    
    if (dashboardName === 'all' || dashboardName === 'help') {
      // Show all dashboards
      console.log(chalk.bold('Available Dashboards:'));
      console.log();
      
      for (const [name, url] of Object.entries(DASHBOARDS)) {
        console.log(`  ${chalk.cyan(name.padEnd(15))} ${chalk.dim(url)}`);
      }
      
      console.log();
      console.log(chalk.bold('Commands:'));
      console.log(`  ${chalk.cyan('/dashboard monitor')}     - Live orchestration monitor`);
      console.log(`  ${chalk.cyan('/dashboard prd')}         - PRD viewer with all stories`);
      console.log(`  ${chalk.cyan('/dashboard cost')}        - Cost tracking dashboard`);
      console.log(`  ${chalk.cyan('/dashboard agents')}      - Agent profiles viewer`);
      console.log(`  ${chalk.cyan('/dashboard orchestration')} - Orchestration plan diagram`);
      console.log(`  ${chalk.cyan('/dashboard all')}         - Open all dashboards`);
      console.log();
      
      if (dashboardName === 'help') {
        return true;
      }
    }
    
    // Open specific dashboard(s)
    const toOpen = dashboardName === 'all' 
      ? Object.entries(DASHBOARDS)
      : [[dashboardName, DASHBOARDS[dashboardName as keyof typeof DASHBOARDS]]];
    
    let opened = 0;
    let failed = 0;
    
    for (const [name, url] of toOpen) {
      if (!url) {
        console.log(chalk.red(`Unknown dashboard: ${dashboardName}`));
        console.log(chalk.dim('Use /dashboard to see available dashboards'));
        console.log();
        return true;
      }
      
      try {
        // Try to open in browser
        await execa('xdg-open', [url], { 
          reject: false,
          timeout: 5000,
        });
        console.log(`  ${chalk.green('✓')} ${name}: ${chalk.dim(url)}`);
        opened++;
      } catch {
        // Fallback for macOS
        try {
          await execa('open', [url], { 
            reject: false,
            timeout: 5000,
          });
          console.log(`  ${chalk.green('✓')} ${name}: ${chalk.dim(url)}`);
          opened++;
        } catch {
          console.log(`  ${chalk.yellow('!')} ${name}: ${chalk.dim(url)} ${chalk.dim('(auto-open failed, copy URL)')}`);
          failed++;
        }
      }
    }
    
    console.log();
    console.log(chalk.dim(`Opened: ${opened}, Failed: ${failed}`));
    console.log();
    
    return true;
  },
};
