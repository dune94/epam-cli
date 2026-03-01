import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { BackendClient } from '../../http/BackendClient.js';
import { getProjectId } from '../../constraints/sessionPrompt.js';
import { pathExists, readJsonFile, writeJsonFile } from '../../utils/fs.js';

interface SyncState {
  lastPushTimestamp: string | null;
  lastPullTimestamp: string | null;
  projectId: string | null;
}

interface SyncPayload {
  contextMd: string;
  decisionsJsonl: string;
  timestamp: string;
}

interface SyncResponse {
  contextMd: string;
  decisionsJsonl: string;
  timestamp: string;
}

async function getSyncStatePath(projectRoot: string): Promise<string> {
  return path.join(projectRoot, '.epam', '.sync-state.json');
}

async function loadSyncState(projectRoot: string): Promise<SyncState> {
  const syncStatePath = await getSyncStatePath(projectRoot);
  const state = await readJsonFile<SyncState>(syncStatePath);
  return state ?? {
    lastPushTimestamp: null,
    lastPullTimestamp: null,
    projectId: null,
  };
}

async function saveSyncState(projectRoot: string, state: SyncState): Promise<void> {
  const syncStatePath = await getSyncStatePath(projectRoot);
  await writeJsonFile(syncStatePath, state);
}

async function readContextFile(projectRoot: string): Promise<string> {
  const contextPath = path.join(projectRoot, '.epam', 'context.md');
  if (await pathExists(contextPath)) {
    return await fs.readFile(contextPath, 'utf-8');
  }
  return '';
}

async function readDecisionsFile(projectRoot: string): Promise<string> {
  const decisionsPath = path.join(projectRoot, '.epam', 'decisions.jsonl');
  if (await pathExists(decisionsPath)) {
    return await fs.readFile(decisionsPath, 'utf-8');
  }
  return '';
}

async function writeContextFile(projectRoot: string, content: string): Promise<void> {
  const contextPath = path.join(projectRoot, '.epam', 'context.md');
  const dirPath = path.dirname(contextPath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(contextPath, content, 'utf-8');
}

async function writeDecisionsFile(projectRoot: string, content: string): Promise<void> {
  const decisionsPath = path.join(projectRoot, '.epam', 'decisions.jsonl');
  const dirPath = path.dirname(decisionsPath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(decisionsPath, content, 'utf-8');
}

async function getLocalTimestamp(projectRoot: string): Promise<string | null> {
  const contextPath = path.join(projectRoot, '.epam', 'context.md');
  const decisionsPath = path.join(projectRoot, '.epam', 'decisions.jsonl');

  let latestTimestamp: number = 0;

  if (await pathExists(contextPath)) {
    const stats = await fs.stat(contextPath);
    latestTimestamp = Math.max(latestTimestamp, stats.mtimeMs);
  }

  if (await pathExists(decisionsPath)) {
    const stats = await fs.stat(decisionsPath);
    latestTimestamp = Math.max(latestTimestamp, stats.mtimeMs);
  }

  if (latestTimestamp === 0) {
    return null;
  }

  return new Date(latestTimestamp).toISOString();
}

function diffLines(local: string, remote: string): { added: number; removed: number } {
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  const localSet = new Set(localLines);
  const remoteSet = new Set(remoteLines);

  let added = 0;
  let removed = 0;

  for (const line of remoteLines) {
    if (!localSet.has(line)) {
      added++;
    }
  }

  for (const line of localLines) {
    if (!remoteSet.has(line)) {
      removed++;
    }
  }

  return { added, removed };
}

export function createSyncCommand(): Command {
  const sync = new Command('sync')
    .description('Sync project context and decisions with shared backend');

  // ── sync push ──
  sync.addCommand(
    new Command('push')
      .description('Push local context and decisions to backend')
      .option('--force', 'Force push regardless of remote state')
      .action(async (opts) => {
        try {
          const config = await resolveConfig({});
          const projectRoot = config.projectRoot ?? process.cwd();

          const authManager = new AuthManager(config.backendUrl);

          // Check authentication
          if (!(await authManager.isAuthenticated())) {
            console.log(
              chalk.red('✗ Not authenticated. Run ') +
              chalk.cyan('epam login') +
              chalk.red(' first.')
            );
            process.exit(1);
          }

          const client = new BackendClient(config.backendUrl, authManager);
          const projectId = getProjectId(projectRoot);

          const contextMd = await readContextFile(projectRoot);
          const decisionsJsonl = await readDecisionsFile(projectRoot);

          const payload: SyncPayload = {
            contextMd,
            decisionsJsonl,
            timestamp: new Date().toISOString(),
          };

          await client.syncPush(projectId, payload);

          const syncState = await loadSyncState(projectRoot);
          syncState.lastPushTimestamp = payload.timestamp;
          syncState.projectId = projectId;
          await saveSyncState(projectRoot, syncState);

          if (opts.force) {
            console.log(chalk.green('✓ Force-pushed local over remote (--force)'));
          } else {
            console.log(chalk.green('✓ Pushed context and decisions to backend'));
          }
        } catch (error) {
          process.stderr.write(
            chalk.red(`✗ Error: ${error instanceof Error ? error.message : String(error)}\n`)
          );
          process.exit(1);
        }
      })
  );

  // ── sync pull ──
  sync.addCommand(
    new Command('pull')
      .description('Pull shared context and decisions from backend')
      .option('--force <side>', 'Force resolve conflict (local or remote)')
      .action(async (opts) => {
        try {
          const config = await resolveConfig({});
          const projectRoot = config.projectRoot ?? process.cwd();

          const authManager = new AuthManager(config.backendUrl);

          // Check authentication
          if (!(await authManager.isAuthenticated())) {
            console.log(
              chalk.red('✗ Not authenticated. Run ') +
              chalk.cyan('epam login') +
              chalk.red(' first.')
            );
            process.exit(1);
          }

          const client = new BackendClient(config.backendUrl, authManager);
          const projectId = getProjectId(projectRoot);

          const remote = await client.syncPull(projectId);
          const syncState = await loadSyncState(projectRoot);
          const localTimestamp = await getLocalTimestamp(projectRoot);

          // Check for divergence
          const remoteTimestamp = new Date(remote.timestamp);
          const lastPull = syncState.lastPullTimestamp ? new Date(syncState.lastPullTimestamp) : null;
          const lastPush = syncState.lastPushTimestamp ? new Date(syncState.lastPushTimestamp) : null;

          const remoteNewer = lastPull ? remoteTimestamp > lastPull : true;
          const localModified = lastPush ? (localTimestamp && new Date(localTimestamp) > lastPush) : Boolean(localTimestamp);

          // Divergence detection
          if (remoteNewer && localModified && !opts.force) {
            const localContext = await readContextFile(projectRoot);
            const localDecisions = await readDecisionsFile(projectRoot);

            const contextDiff = diffLines(localContext, remote.contextMd);
            const decisionsDiff = diffLines(localDecisions, remote.decisionsJsonl);

            console.log(chalk.yellow('\n⚠  Conflict detected — local and remote have both changed since last sync\n'));
            console.log('  Context diff:');
            console.log(`    ${chalk.green(`+${contextDiff.added} lines`)} ${chalk.red(`-${contextDiff.removed} lines`)}`);
            console.log('  Decisions diff:');
            console.log(`    ${chalk.green(`+${decisionsDiff.added} lines`)} ${chalk.red(`-${decisionsDiff.removed} lines`)}`);
            console.log();
            console.log(chalk.dim('  Use --force local or --force remote to resolve.'));
            console.log();
            process.exit(1);
          }

          // Handle force resolution
          if (opts.force === 'remote') {
            await writeContextFile(projectRoot, remote.contextMd);
            await writeDecisionsFile(projectRoot, remote.decisionsJsonl);

            syncState.lastPullTimestamp = remote.timestamp;
            await saveSyncState(projectRoot, syncState);

            console.log(chalk.green('✓ Overwrote local with remote (--force remote)'));
            return;
          }

          if (opts.force === 'local') {
            // Do nothing - keep local files
            syncState.lastPullTimestamp = remote.timestamp;
            await saveSyncState(projectRoot, syncState);

            console.log(chalk.green('✓ Kept local files (--force local)'));
            return;
          }

          // Normal pull: only update if remote is newer
          if (remoteNewer) {
            await writeContextFile(projectRoot, remote.contextMd);
            await writeDecisionsFile(projectRoot, remote.decisionsJsonl);

            syncState.lastPullTimestamp = remote.timestamp;
            await saveSyncState(projectRoot, syncState);

            console.log(chalk.green('✓ Pulled latest context and decisions from backend'));
          } else {
            console.log(chalk.dim('  Local is up to date (remote not newer)'));
          }
        } catch (error) {
          process.stderr.write(
            chalk.red(`✗ Error: ${error instanceof Error ? error.message : String(error)}\n`)
          );
          process.exit(1);
        }
      })
  );

  // ── sync status ──
  sync.addCommand(
    new Command('status')
      .description('Show sync status and diff summary')
      .action(async () => {
        try {
          const config = await resolveConfig({});
          const projectRoot = config.projectRoot ?? process.cwd();

          const syncState = await loadSyncState(projectRoot);

          console.log(chalk.bold('\nSync Status:\n'));
          console.log(`  Last push:  ${syncState.lastPushTimestamp ? chalk.cyan(new Date(syncState.lastPushTimestamp).toLocaleString()) : chalk.dim('never')}`);
          console.log(`  Last pull:  ${syncState.lastPullTimestamp ? chalk.cyan(new Date(syncState.lastPullTimestamp).toLocaleString()) : chalk.dim('never')}`);

          // Try to fetch remote for diff summary (requires auth)
          const authManager = new AuthManager(config.backendUrl);

          if (!(await authManager.isAuthenticated())) {
            console.log(chalk.dim('\n  (Not authenticated - run "epam login" to see remote diff)'));
            console.log();
            return;
          }

          const client = new BackendClient(config.backendUrl, authManager);
          const projectId = getProjectId(projectRoot);

          try {
            const remote = await client.syncPull(projectId);
            const localContext = await readContextFile(projectRoot);
            const localDecisions = await readDecisionsFile(projectRoot);

            const contextDiff = diffLines(localContext, remote.contextMd);
            const decisionsDiff = diffLines(localDecisions, remote.decisionsJsonl);

            console.log();
            console.log(chalk.bold('  Local vs Remote:'));
            console.log();
            console.log('    context.md:');
            console.log(`      ${chalk.green(`+${contextDiff.added} lines`)} ${chalk.red(`-${contextDiff.removed} lines`)}`);
            console.log('    decisions.jsonl:');
            console.log(`      ${chalk.green(`+${decisionsDiff.added} lines`)} ${chalk.red(`-${decisionsDiff.removed} lines`)}`);
          } catch (error) {
            console.log(chalk.dim('\n  (Could not fetch remote - server error or no data)'));
          }

          console.log();
        } catch (error) {
          process.stderr.write(
            chalk.red(`✗ Error: ${error instanceof Error ? error.message : String(error)}\n`)
          );
          process.exit(1);
        }
      })
  );

  return sync;
}
