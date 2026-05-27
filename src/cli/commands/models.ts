import { Command } from 'commander';
import chalk from 'chalk';

const MODELS: Record<string, { provider: string; description: string; default?: boolean }> = {
  // ─── Anthropic ─────────────────────────────────────────────────────────────
  'claude-opus-4-7':            { provider: 'anthropic', description: 'Latest and most capable Claude model' },
  'claude-opus-4-6':            { provider: 'anthropic', description: 'Highly capable Claude Opus' },
  'claude-sonnet-4-6':          { provider: 'anthropic', description: 'Balanced performance and speed', default: true },
  'claude-haiku-4-5-20251001':  { provider: 'anthropic', description: 'Fastest Claude model' },
  // ─── OpenAI ────────────────────────────────────────────────────────────────
  'gpt-4.1':                    { provider: 'openai', description: 'GPT-4.1 flagship' },
  'gpt-4.1-mini':               { provider: 'openai', description: 'GPT-4.1 efficient' },
  'gpt-4o':                     { provider: 'openai', description: 'GPT-4o multimodal' },
  'gpt-4o-mini':                { provider: 'openai', description: 'GPT-4o compact' },
  'o3':                         { provider: 'openai', description: 'Advanced reasoning' },
  'o4-mini':                    { provider: 'openai', description: 'o4 compact reasoning' },
  // ─── Gemini ────────────────────────────────────────────────────────────────
  'gemini-2.5-pro':             { provider: 'gemini', description: 'Google Gemini 2.5 Pro (most capable)' },
  'gemini-2.5-flash':           { provider: 'gemini', description: 'Google Gemini 2.5 Flash (fast)' },
  'gemini-2.0-flash':           { provider: 'gemini', description: 'Google Gemini 2.0 Flash' },
};

export function createModelsCommand(): Command {
  return new Command('models')
    .description('List available models')
    .option('-p, --provider <provider>', 'Filter by provider')
    .action(opts => {
      const entries = Object.entries(MODELS).filter(
        ([, m]) => !opts.provider || m.provider === opts.provider
      );

      console.log(chalk.bold('Available Models:\n'));

      const byProvider: Record<string, typeof entries> = {};
      for (const entry of entries) {
        const p = entry[1].provider;
        if (!byProvider[p]) byProvider[p] = [];
        byProvider[p].push(entry);
      }

      for (const [prov, models] of Object.entries(byProvider)) {
        console.log(chalk.bold.cyan(prov));
        for (const [name, info] of models) {
          const tag = info.default ? chalk.green(' (default)') : '';
          console.log(`  ${chalk.white(name)}${tag}`);
          console.log(chalk.dim(`    ${info.description}`));
        }
        console.log();
      }
    });
}
