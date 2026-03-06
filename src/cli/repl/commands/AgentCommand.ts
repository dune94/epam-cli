/**
 * /agent — Named agent persona switching
 *
 * Two sources (displayed separately):
 *   - Orchestration agents: read-only from ./orchestrations/agents/profiles.json
 *   - Session agents: user-managed in ~/.epam/agents/<name>.json + built-in defaults
 *
 * Commands:
 *   /agent                        List all available agents
 *   /agent switch <name>          Switch active agent persona (live, next turn)
 *   /agent show <name>            Show full system prompt for an agent
 *   /agent add <name> <prompt>    Save a new session agent
 *   /agent remove <name>          Delete a session agent (not built-in or orchestration)
 *   /agent reset                  Restore the default system prompt
 */

import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { readBuiltinAgents } from '../DataConfig.js';

// ── Built-in session agent defaults ──────────────────────────────────────────

function builtinAgents(): Record<string, string> { return readBuiltinAgents(); }

// ── Agent store helpers ───────────────────────────────────────────────────────

function sessionAgentsDir(): string {
  const dir = join(homedir(), '.epam', 'agents');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function activeAgentPath(): string { return join(sessionAgentsDir(), '.active'); }

function loadActiveAgent(): string | null {
  try { return readFileSync(activeAgentPath(), 'utf8').trim() || null; } catch { return null; }
}

function saveActiveAgent(name: string | null): void {
  if (name) writeFileSync(activeAgentPath(), name);
  else { try { unlinkSync(activeAgentPath()); } catch { /* ok */ } }
}

function loadSessionAgents(): Record<string, string> {
  const dir = sessionAgentsDir();
  const agents: Record<string, string> = {};
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const { name, prompt } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (name && prompt) agents[name] = prompt;
    } catch { /* skip malformed */ }
  }
  return agents;
}

function saveSessionAgent(name: string, prompt: string): void {
  const p = join(sessionAgentsDir(), `${sanitize(name)}.json`);
  writeFileSync(p, JSON.stringify({ name, prompt, addedAt: new Date().toISOString() }, null, 2));
}

function deleteSessionAgent(name: string): boolean {
  const p = join(sessionAgentsDir(), `${sanitize(name)}.json`);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

function sanitize(s: string): string { return s.replace(/[^a-z0-9_.-]/gi, '_'); }

// ── Load orchestration agents (read-only) ─────────────────────────────────────

function loadOrchestrationAgents(): Record<string, string> {
  const candidates = [
    join(process.cwd(), 'orchestrations', 'agents', 'profiles.json'),
    join(resolve(process.cwd(), '..'), 'orchestrations', 'agents', 'profiles.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* skip */ }
    }
  }
  return {};
}

// ── Resolve a named agent's prompt ───────────────────────────────────────────

function resolveAgent(name: string): string | null {
  const sessionAgents = { ...builtinAgents(), ...loadSessionAgents() };
  if (sessionAgents[name]) return sessionAgents[name];
  const orchAgents = loadOrchestrationAgents();
  if (orchAgents[name]) return orchAgents[name];
  return null;
}

// ── Command ───────────────────────────────────────────────────────────────────

export const agentCommand: SlashCommand = {
  name: 'agent',
  aliases: ['agents'],
  description: 'List or switch named agent personas',
  usage: '[switch <name> | show <name> | add <name> <prompt> | remove <name> | reset]',

  async execute(args, ctx: SlashCommandContext): Promise<boolean> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub   = parts[0]?.toLowerCase() ?? '';

    // ── switch ────────────────────────────────────────────────────────────────
    if (sub === 'switch' || sub === 'use') {
      const name = parts[1];
      if (!name) {
        console.log(chalk.red('Usage: /agent switch <name>'));
        console.log(chalk.dim('See agents with: /agent'));
        return true;
      }
      const prompt = resolveAgent(name);
      if (!prompt) {
        console.log(chalk.red(`Agent "${name}" not found.`));
        console.log(chalk.dim('List agents with: /agent'));
        return true;
      }
      if (!ctx.onSystemPromptChange) {
        console.log(chalk.yellow('⚠  System prompt switching not available in this session.'));
        return true;
      }
      ctx.onSystemPromptChange(prompt);
      saveActiveAgent(name);
      console.log(chalk.green(`✓ Switched to agent "${name}"`));
      console.log(chalk.dim('  System prompt updated — takes effect on your next message.'));
      return true;
    }

    // ── reset ─────────────────────────────────────────────────────────────────
    if (sub === 'reset') {
      if (!ctx.onSystemPromptChange || !ctx.defaultSystemPrompt) {
        console.log(chalk.yellow('⚠  Default system prompt not available.'));
        return true;
      }
      ctx.onSystemPromptChange(ctx.defaultSystemPrompt);
      saveActiveAgent(null);
      console.log(chalk.green('✓ Reset to default system prompt.'));
      return true;
    }

    // ── show ──────────────────────────────────────────────────────────────────
    if (sub === 'show') {
      const name = parts[1];
      if (!name) {
        console.log(chalk.red('Usage: /agent show <name>'));
        return true;
      }
      const prompt = resolveAgent(name);
      if (!prompt) {
        console.log(chalk.red(`Agent "${name}" not found.`));
        return true;
      }
      console.log(chalk.bold(`\n  Agent: ${name}\n`));
      // Word-wrap at 80 cols
      const words = prompt.split(' ');
      let line = '  ';
      for (const w of words) {
        if ((line + w).length > 80) { console.log(line); line = '  ' + w + ' '; }
        else { line += w + ' '; }
      }
      if (line.trim()) console.log(line);
      console.log();
      return true;
    }

    // ── add ───────────────────────────────────────────────────────────────────
    if (sub === 'add') {
      const name   = parts[1];
      const prompt = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');
      if (!name || !prompt) {
        console.log(chalk.red('Usage: /agent add <name> <prompt text>'));
        console.log(chalk.dim('Example: /agent add security "You are a security expert..."'));
        return true;
      }
      if (builtinAgents()[name]) {
        console.log(chalk.red(`"${name}" is a built-in agent and cannot be overwritten.`));
        return true;
      }
      saveSessionAgent(name, prompt);
      console.log(chalk.green(`✓ Agent "${name}" saved.`));
      console.log(chalk.dim(`  Switch to it with: /agent switch ${name}`));
      return true;
    }

    // ── remove ────────────────────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const name = parts[1];
      if (!name) {
        console.log(chalk.red('Usage: /agent remove <name>'));
        return true;
      }
      if (builtinAgents()[name]) {
        console.log(chalk.red(`"${name}" is a built-in agent and cannot be removed.`));
        return true;
      }
      const orchAgents = loadOrchestrationAgents();
      if (orchAgents[name]) {
        console.log(chalk.red(`"${name}" is a read-only orchestration agent.`));
        return true;
      }
      if (deleteSessionAgent(name)) {
        if (loadActiveAgent() === name) saveActiveAgent(null);
        console.log(chalk.green(`✓ Agent "${name}" removed.`));
      } else {
        console.log(chalk.red(`Agent "${name}" not found in session agents.`));
      }
      return true;
    }

    // ── default: list ─────────────────────────────────────────────────────────
    const activeAgent    = loadActiveAgent();
    const sessionCustom  = loadSessionAgents();
    const orchAgents     = loadOrchestrationAgents();

    const marker = (name: string) =>
      name === activeAgent ? chalk.green('✓ ') : chalk.dim('○ ');
    const label = (name: string) =>
      name === activeAgent ? chalk.green.bold(name) + chalk.green(' ← active') : name;

    console.log(chalk.bold('\nSession agents') + chalk.dim('  (user-managed)\n'));
    const allSession = { ...builtinAgents(), ...sessionCustom };
    for (const [name, prompt] of Object.entries(allSession)) {
      const tag = builtinAgents()[name] ? chalk.dim(' [built-in]') : chalk.dim(' [custom]');
      console.log(`  ${marker(name)}${label(name)}${tag}`);
      console.log(chalk.dim(`    ${prompt.slice(0, 72)}…`));
    }

    if (Object.keys(orchAgents).length > 0) {
      console.log(chalk.bold('\nOrchestration agents') + chalk.dim('  (switchable, file managed externally)\n'));
      for (const [name, prompt] of Object.entries(orchAgents)) {
        console.log(`  ${marker(name)}${label(name)}`);
        console.log(chalk.dim(`    ${prompt.slice(0, 72)}…`));
      }
    }

    console.log();
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  /agent switch <name>           — activate agent (next message)'));
    console.log(chalk.dim('  /agent show <name>             — show full system prompt'));
    console.log(chalk.dim('  /agent add <name> <prompt>     — save a new session agent'));
    console.log(chalk.dim('  /agent remove <name>           — remove a session agent'));
    console.log(chalk.dim('  /agent reset                   — restore default system prompt\n'));
    return true;
  },
};
