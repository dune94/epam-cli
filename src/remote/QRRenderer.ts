/**
 * QRRenderer - Simple terminal QR code renderer
 *
 * Note: This is a simplified implementation for terminal display.
 * For production use, consider using a dedicated QR code library like 'qrcode-terminal'.
 */

import chalk from 'chalk';

/**
 * Render a QR code to the terminal
 * For now, this creates a stylized ASCII representation
 * The actual QR encoding would require a proper QR library
 *
 * @param url - The URL to encode in the QR code
 * @returns The rendered QR code as a string
 */
export function renderQRCode(url: string): string {
  // Create a simple bordered display with the URL
  // In production, this would use a proper QR encoding library
  const lines: string[] = [];
  const width = 40;
  const padding = 2;

  // Top border
  lines.push(chalk.white('█'.repeat(width)));

  // Empty padding rows
  for (let i = 0; i < padding; i++) {
    lines.push(chalk.white('█') + ' '.repeat(width - 2) + chalk.white('█'));
  }

  // QR code placeholder - simplified pattern
  // In production, this would be actual QR encoding
  const qrSize = 24;
  const qrPadding = Math.floor((width - 2 - qrSize) / 2);

  for (let y = 0; y < qrSize; y++) {
    let row = chalk.white('█') + ' '.repeat(qrPadding);

    // Create a simple pattern (not a real QR code)
    // Real implementation would use QR encoding algorithm
    for (let x = 0; x < qrSize; x++) {
      // Simple hash-based pattern generation for visual effect
      const hash = (x * 7 + y * 13 + url.length) % 3;
      row += hash === 0 ? chalk.white('█') : ' ';
    }

    row += ' '.repeat(width - 2 - qrPadding - qrSize) + chalk.white('█');
    lines.push(row);
  }

  // Empty padding rows
  for (let i = 0; i < padding; i++) {
    lines.push(chalk.white('█') + ' '.repeat(width - 2) + chalk.white('█'));
  }

  // Bottom border
  lines.push(chalk.white('█'.repeat(width)));

  // Add instruction text below
  lines.push('');
  lines.push(chalk.dim('Scan with your mobile device'));
  lines.push(chalk.dim('(QR code encoding - placeholder)'));

  return lines.join('\n');
}

/**
 * Render a QR code with fallback URL display
 * This ensures the URL is always accessible even if QR rendering fails
 *
 * @param url - The URL to encode
 * @returns Rendered QR code with URL fallback
 */
export function renderQRWithFallback(url: string): string {
  const qr = renderQRCode(url);
  const fallback = `\n${chalk.cyan('Claim URL:')} ${chalk.bold(url)}\n`;
  return qr + fallback;
}

/**
 * Create a simple countdown display string
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
