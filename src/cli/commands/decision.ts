import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { userInfo } from 'os';
import chalk from 'chalk';
import { DecisionStore } from '../../decisions/DecisionStore.js';
import type { Decision } from '../../decisions/types.js';

async function promptForDecision(): Promise<Omit<Decision, 'id' | 'createdAt'>> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const title = await rl.question('Title: ');
    const description = await rl.question('Description (optional): ');
    const rationale = await rl.question('Rationale: ');
    const pattern_to_avoid = await rl.question('Pattern to avoid: ');
    const approved_alternative = await rl.question('Approved alternative: ');
    const tagsInput = await rl.question('Tags (comma-separated): ');

    const tags = tagsInput
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const author = process.env.GIT_AUTHOR_NAME ||
                   process.env.USER ||
                   process.env.USERNAME ||
                   userInfo().username;

    return {
      title: title.trim(),
      description: description.trim() || undefined,
      rationale: rationale.trim(),
      pattern_to_avoid: pattern_to_avoid.trim(),
      approved_alternative: approved_alternative.trim(),
      tags,
      author,
    };
  } finally {
    rl.close();
  }
}

function formatDecisionTable(decisions: Decision[]): void {
  if (decisions.length === 0) {
    console.log('No decisions found.');
    return;
  }

  console.log(chalk.bold('\nDecision Records:\n'));

  for (const decision of decisions) {
    console.log(chalk.cyan(`${decision.id}`) + chalk.white(` — ${decision.title}`));
    if (decision.description) {
      console.log(`  Description: ${decision.description}`);
    }
    console.log(`  Rationale: ${decision.rationale}`);
    console.log(`  Pattern to avoid: ${chalk.red(decision.pattern_to_avoid)}`);
    console.log(`  Approved alternative: ${chalk.green(decision.approved_alternative)}`);
    if (decision.tags.length > 0) {
      console.log(`  Tags: ${decision.tags.join(', ')}`);
    }
    console.log(`  Author: ${decision.author}`);
    console.log(`  Created: ${new Date(decision.createdAt).toLocaleString()}`);
    console.log();
  }
}

export function createDecisionCommand(): Command {
  const decision = new Command('decision')
    .description('Manage architectural decision records');

  decision.addCommand(
    new Command('add')
      .description('Add a new decision record')
      .action(async () => {
        try {
          const projectRoot = process.cwd();
          const store = new DecisionStore(projectRoot);

          console.log(chalk.bold('Add Decision Record\n'));
          const decisionData = await promptForDecision();

          const newDecision = await store.add(decisionData);
          console.log(chalk.green(`\n✓ Decision ${newDecision.id} added successfully`));
        } catch (error) {
          process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        }
      })
  );

  decision.addCommand(
    new Command('list')
      .description('List all decision records')
      .action(async () => {
        try {
          const projectRoot = process.cwd();
          const store = new DecisionStore(projectRoot);
          const decisions = await store.list();

          formatDecisionTable(decisions);
        } catch (error) {
          process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        }
      })
  );

  decision.addCommand(
    new Command('search')
      .description('Search decision records')
      .argument('<query>', 'Search query')
      .action(async (query: string) => {
        try {
          const projectRoot = process.cwd();
          const store = new DecisionStore(projectRoot);
          const decisions = await store.search(query);

          if (decisions.length === 0) {
            console.log(`No decisions found matching "${query}"`);
          } else {
            console.log(chalk.bold(`\nFound ${decisions.length} decision(s) matching "${query}":`));
            formatDecisionTable(decisions);
          }
        } catch (error) {
          process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        }
      })
  );

  return decision;
}
