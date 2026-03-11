/**
 * /remote Slash Command
 *
 * Generate QR code for mobile continuation, reclaim sessions, and manage remote state
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { SessionLock } from '../../../remote/SessionLock.js';
import { renderQRWithFallback, formatCountdown } from '../../../remote/QRRenderer.js';
import {
  forkSessionForRemote,
  importRemoteSession,
  generateEncryptionKey,
} from '../../../remote/SessionSerializer.js';
import { BackendClient } from '../../../http/BackendClient.js';
import { AuthManager } from '../../../auth/AuthManager.js';

// Store the encryption key and claim token in memory
let currentEncryptionKey: Buffer | null = null;
let currentClaimToken: string | null = null;
let countdownInterval: NodeJS.Timeout | null = null;

/**
 * Helper to get or create BackendClient
 */
function getBackendClient(backendUrl: string): BackendClient {
  const authManager = new AuthManager(backendUrl);
  return new BackendClient(backendUrl, authManager);
}

/**
 * Clean up countdown interval
 */
function cleanupCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/**
 * /remote generate (default) - Fork session, POST to backend, show QR code
 */
async function generateRemoteSession(ctx: SlashCommandContext): Promise<void> {
  const { config, messages, currentModel, currentProvider, tokenCount, sessionTurnCount } = ctx;

  // Check backend URL
  if (!config.backendUrl) {
    console.log(chalk.yellow('Remote sessions require a backend. Set EPAM_BACKEND_URL.'));
    return;
  }

  // Check if lock already exists
  if (SessionLock.isLocked()) {
    console.log(
      chalk.yellow(
        'A remote session is already active. Use /remote status or /remote cancel.'
      )
    );
    return;
  }

  try {
    // Generate encryption key
    currentEncryptionKey = generateEncryptionKey();

    // Fork session
    const bundle = forkSessionForRemote(
      messages,
      {
        model: currentModel,
        provider: currentProvider,
        projectRoot: config.projectRoot,
        tokenCount,
        turnCount: sessionTurnCount,
      },
      currentEncryptionKey
    );

    // POST to backend
    const client = getBackendClient(config.backendUrl);
    const result = await client.createRemoteSession(bundle);

    // Store claim token
    currentClaimToken = result.claimToken;

    // Parse TTL from expiresAt
    const expiresAt = new Date(result.expiresAt);
    const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

    // Acquire session lock
    if (!SessionLock.acquire(result.claimToken, ttlSeconds)) {
      console.log(
        chalk.red('Failed to acquire session lock (unexpected)')
      );
      return;
    }

    // Render QR code with fallback URL
    console.log();
    console.log(renderQRWithFallback(result.url));
    console.log();

    // Start countdown spinner
    let remainingSeconds = ttlSeconds;
    let sigintHandler: (() => void) | null = null;

    // Set up SIGINT handler for Ctrl+C
    sigintHandler = () => {
      cleanupCountdown();
      SessionLock.forceRelease();

      // Clean up backend session
      client
        .reclaimRemoteSession(result.claimToken)
        .catch(() => {
          // Session may already be claimed or expired, ignore error
        });

      console.log();
      console.log(chalk.dim('Remote session cancelled'));
      console.log();

      // Remove SIGINT handler
      if (sigintHandler) {
        process.off('SIGINT', sigintHandler);
      }
    };

    process.on('SIGINT', sigintHandler);

    // Countdown loop
    countdownInterval = setInterval(() => {
      remainingSeconds--;

      if (remainingSeconds <= 0) {
        cleanupCountdown();
        SessionLock.release();

        // Clean up backend session
        client
          .reclaimRemoteSession(result.claimToken)
          .catch(() => {
            // Session may already be claimed or expired, ignore error
          });

        console.log();
        console.log(formatCountdown(0)); // Shows "Remote session expired"
        console.log();

        // Remove SIGINT handler
        if (sigintHandler) {
          process.off('SIGINT', sigintHandler);
        }
      } else {
        // Update countdown display
        process.stdout.write('\r' + formatCountdown(remainingSeconds));
      }
    }, 1000);

    // Initial countdown display
    process.stdout.write(formatCountdown(remainingSeconds));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.red(`Remote command failed: ${message}`));
    console.log();
  }
}

/**
 * /remote reclaim - GET updated session from backend, import, release lock
 */
async function reclaimRemoteSession(ctx: SlashCommandContext): Promise<void> {
  const { config } = ctx;

  // Check backend URL
  if (!config.backendUrl) {
    console.log(chalk.yellow('Remote sessions require a backend. Set EPAM_BACKEND_URL.'));
    return;
  }

  // Check if we have an active remote session
  if (!currentClaimToken || !currentEncryptionKey) {
    console.log(chalk.dim('No active remote session'));
    return;
  }

  try {
    // GET session from backend
    const client = getBackendClient(config.backendUrl);
    const bundle = await client.reclaimRemoteSession(currentClaimToken);

    // Decrypt and import session
    const sessionData = importRemoteSession(bundle, currentEncryptionKey);

    // Import messages into current context
    ctx.messages.length = 0;
    ctx.messages.push(...sessionData.messages);

    // Force release lock
    SessionLock.forceRelease();

    // Clean up
    cleanupCountdown();
    currentClaimToken = null;
    currentEncryptionKey = null;

    console.log();
    console.log(chalk.green('✓ Remote session reclaimed'));
    console.log(chalk.dim(`  Imported ${sessionData.messages.length} messages`));
    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.red(`Remote command failed: ${message}`));
    console.log();
  }
}

/**
 * /remote status - Display lock state, TTL, claim status
 */
async function showRemoteStatus(_ctx: SlashCommandContext): Promise<void> {
  const lockState = SessionLock.getState();

  if (!lockState) {
    console.log(chalk.dim('No active remote session'));
    return;
  }

  const remainingTTL = SessionLock.getRemainingTTL();
  const lockStateStr = SessionLock.isLocked() ? chalk.green('locked') : chalk.dim('unlocked');
  const claimStatus =
    remainingTTL > 0
      ? chalk.yellow('unclaimed')
      : chalk.red('expired');
  const tokenPrefix = lockState.claimToken.slice(0, 8);

  console.log();
  console.log(chalk.bold('Remote Session Status:'));
  console.log();
  console.log(`  Lock state:    ${lockStateStr}`);
  console.log(`  TTL remaining: ${chalk.white(remainingTTL)}s`);
  console.log(`  Claim status:  ${claimStatus}`);
  console.log(`  Token prefix:  ${chalk.dim(tokenPrefix)}...`);
  console.log();
}

/**
 * /remote cancel - Cancel active session, release lock, delete backend session
 */
async function cancelRemoteSession(ctx: SlashCommandContext): Promise<void> {
  const { config } = ctx;

  // Check if we have an active remote session
  if (!currentClaimToken) {
    console.log(chalk.dim('No active remote session'));
    return;
  }

  // Check backend URL
  if (!config.backendUrl) {
    console.log(chalk.yellow('Remote sessions require a backend. Set EPAM_BACKEND_URL.'));
    return;
  }

  try {
    // Try to delete from backend (may fail if already claimed, that's OK)
    const client = getBackendClient(config.backendUrl);
    await client.reclaimRemoteSession(currentClaimToken).catch(() => {
      // Ignore 404/409 errors - session may already be claimed
    });

    // Release lock and clean up
    SessionLock.forceRelease();
    cleanupCountdown();
    currentClaimToken = null;
    currentEncryptionKey = null;

    console.log();
    console.log(chalk.green('Remote session cancelled'));
    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.red(`Remote command failed: ${message}`));
    console.log();
  }
}

/**
 * /remote help - Print usage information
 */
function showRemoteHelp(): void {
  console.log();
  console.log(chalk.bold('Remote Session Commands:'));
  console.log();
  console.log(`  ${chalk.cyan('/remote')}          ${chalk.dim('Generate QR code and claim URL for mobile continuation')}`);
  console.log(`  ${chalk.cyan('/remote reclaim')}  ${chalk.dim('Import updated session from mobile device')}`);
  console.log(`  ${chalk.cyan('/remote status')}   ${chalk.dim('Show active remote session status')}`);
  console.log(`  ${chalk.cyan('/remote cancel')}   ${chalk.dim('Cancel active remote session')}`);
  console.log(`  ${chalk.cyan('/remote help')}     ${chalk.dim('Show this help message')}`);
  console.log();
}

/**
 * Main remote command implementation
 */
export const remoteCommand: SlashCommand = {
  name: 'remote',
  aliases: ['qr'],
  description: 'Generate QR code for mobile continuation or manage remote sessions',
  usage: '[generate|reclaim|status|cancel|help]',

  async execute(args, ctx): Promise<boolean> {
    const subcommand = args.trim().toLowerCase() || 'generate';

    switch (subcommand) {
      case '':
      case 'generate':
        await generateRemoteSession(ctx);
        break;

      case 'reclaim':
        await reclaimRemoteSession(ctx);
        break;

      case 'status':
        await showRemoteStatus(ctx);
        break;

      case 'cancel':
        await cancelRemoteSession(ctx);
        break;

      case 'help':
        showRemoteHelp();
        break;

      default:
        // Unknown subcommand, show help
        console.log(chalk.yellow(`Unknown subcommand: ${subcommand}`));
        showRemoteHelp();
        break;
    }

    return true;
  },
};
