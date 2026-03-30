import { Command } from 'commander';
import chalk from 'chalk';

const MODELS: Record<string, { provider: string; description: string; default?: boolean }> = {
  'claude-opus-4-6': { provider: 'anthropic', description: 'Most powerful Claude model' },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    description: 'Balanced performance and speed',
    default: true,
  },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', description: 'Fastest Claude model' },
  'gpt-4o': { provider: 'openai', description: 'OpenAI GPT-4o multimodal' },
  'gpt-4o-mini': { provider: 'openai', description: 'Smaller, faster GPT-4o' },
  'gemini-1.5-pro': { provider: 'gemini', description: 'Google Gemini 1.5 Pro' },
  'gemini-1.5-flash': { provider: 'gemini', description: 'Google Gemini 1.5 Flash (fast)' },
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
