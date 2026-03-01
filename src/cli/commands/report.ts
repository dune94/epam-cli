import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { listSessions } from '../../context/SessionStore.js';
import { calculateCost, formatCost } from '../../billing/pricing.js';

interface ReportData {
  totalCost: number;
  costByModel: Record<string, number>;
  sessionCount: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  dateRange: { earliest: Date; latest: Date } | null;
}

export function createReportCommand(): Command {
  return new Command('report')
    .description('Generate burn-up report from session history')
    .option('--client <name>', 'Filter sessions by client name')
    .option('--format <type>', 'Output format: md or json', 'md')
    .action(async opts => {
      try {
        const config = await resolveConfig();
        const allSessions = await listSessions(config.projectRoot, 10000);

        // Filter by client if specified
        const sessions = opts.client
          ? allSessions.filter(s => s.client === opts.client)
          : allSessions;

        if (sessions.length === 0) {
          const msg = opts.client
            ? `No sessions found for client: ${opts.client}`
            : 'No sessions found.';
          if (opts.format === 'json') {
            console.log(JSON.stringify({ error: msg }, null, 2));
          } else {
            console.log(chalk.dim(msg));
          }
          return;
        }

        // Aggregate data
        const report = aggregateReport(sessions);

        // Output in requested format
        if (opts.format === 'json') {
          outputJSON(report);
        } else {
          outputMarkdown(report);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(chalk.red(`Error generating report: ${msg}`));
        process.exit(1);
      }
    });
}

function aggregateReport(
  sessions: Array<{
    model: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    turnCount: number;
    createdAt: Date;
    updatedAt: Date;
  }>
): ReportData {
  const report: ReportData = {
    totalCost: 0,
    costByModel: {},
    sessionCount: sessions.length,
    totalTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    dateRange: null,
  };

  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const session of sessions) {
    report.totalCost += session.totalCost;
    report.totalTurns += session.turnCount;
    report.totalInputTokens += session.totalInputTokens;
    report.totalOutputTokens += session.totalOutputTokens;

    const model = session.model || 'unknown';
    report.costByModel[model] = (report.costByModel[model] || 0) + session.totalCost;

    if (!earliest || session.createdAt < earliest) earliest = session.createdAt;
    if (!latest || session.updatedAt > latest) latest = session.updatedAt;
  }

  if (earliest && latest) {
    report.dateRange = { earliest, latest };
  }

  return report;
}

function outputMarkdown(report: ReportData): void {
  console.log(chalk.bold('\n📊 Burn-up Report\n'));

  console.log(chalk.bold('Summary'));
  console.log(`  Total Cost:        ${chalk.green(formatCost(report.totalCost))}`);
  console.log(`  Sessions:          ${report.sessionCount}`);
  console.log(`  Total Turns:       ${report.totalTurns}`);

  const avgTokensPerTurn = report.totalTurns > 0
    ? Math.round((report.totalInputTokens + report.totalOutputTokens) / report.totalTurns)
    : 0;
  console.log(`  Avg Tokens/Turn:   ${avgTokensPerTurn.toLocaleString()}`);

  if (report.dateRange) {
    const start = report.dateRange.earliest.toLocaleDateString();
    const end = report.dateRange.latest.toLocaleDateString();
    console.log(`  Date Range:        ${start} → ${end}`);
  }

  console.log(chalk.bold('\nCost by Model'));
  const sortedModels = Object.entries(report.costByModel)
    .sort(([, a], [, b]) => b - a);

  for (const [model, cost] of sortedModels) {
    const percentage = report.totalCost > 0
      ? ((cost / report.totalCost) * 100).toFixed(1)
      : '0.0';
    console.log(`  ${model.padEnd(30)} ${formatCost(cost).padEnd(12)} (${percentage}%)`);
  }

  console.log();
}

function outputJSON(report: ReportData): void {
  const output = {
    totalCost: report.totalCost,
    totalCostFormatted: formatCost(report.totalCost),
    sessionCount: report.sessionCount,
    totalTurns: report.totalTurns,
    averageTokensPerTurn: report.totalTurns > 0
      ? Math.round((report.totalInputTokens + report.totalOutputTokens) / report.totalTurns)
      : 0,
    totalInputTokens: report.totalInputTokens,
    totalOutputTokens: report.totalOutputTokens,
    dateRange: report.dateRange
      ? {
          earliest: report.dateRange.earliest.toISOString(),
          latest: report.dateRange.latest.toISOString(),
        }
      : null,
    costByModel: Object.fromEntries(
      Object.entries(report.costByModel).map(([model, cost]) => [
        model,
        {
          cost,
          costFormatted: formatCost(cost),
          percentage: report.totalCost > 0 ? (cost / report.totalCost) * 100 : 0,
        },
      ])
    ),
  };

  console.log(JSON.stringify(output, null, 2));
}
