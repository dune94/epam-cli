/**
 * QRRenderer - Terminal QR code renderer using the 'qrcode' library
 */

import chalk from 'chalk';
import QRCode from 'qrcode';

/**
 * Render a scannable QR code to the terminal.
 *
 * @param url - The URL to encode in the QR code
 * @returns The rendered QR code as a string
 */
export async function renderQRCode(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'terminal', small: true });
}

/**
 * Render a QR code with fallback URL display.
 *
 * @param url - The URL to encode
 * @returns Rendered QR code with URL fallback
 */
export async function renderQRWithFallback(url: string): Promise<string> {
  let qr: string;
  try {
    qr = await renderQRCode(url);
  } catch {
    // If QR generation fails, show URL only
    qr = chalk.yellow('(QR code generation failed)');
  }
  const fallback = `\n${chalk.cyan('Claim URL:')} ${chalk.bold(url)}\n`;
  return qr + fallback;
}

/**
 * Create a simple countdown display string.
 *
 * @param secondsRemaining - Seconds remaining
 * @returns Formatted countdown string
 */
export function formatCountdown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) {
    return chalk.red('Remote session expired');
  }

  return chalk.dim(`Scan to continue on phone… (${secondsRemaining}s remaining)`);
}
