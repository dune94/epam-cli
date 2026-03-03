/**
 * Codemie SSO Authentication Module
 *
 * Handles browser-based SSO authentication for Codemie (Claude-based agent platform).
 * Manages credential storage and session lifecycle.
 *
 * Flow:
 * 1. Start local callback server on random port
 * 2. Open browser to {codeMieUrl}/v1/auth/login/{port}
 * 3. User authenticates in browser
 * 4. Codemie redirects to localhost:{port}?token={base64-encoded-cookies}
 * 5. Extract cookies, fetch config.js to resolve API URL
 * 6. Store credentials with 24h expiry
 */

import { createServer, Server } from 'http';
import open from 'open';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';

/**
 * SSO Authentication result
 */
export interface SSOAuthResult {
  success: boolean;
  apiUrl?: string;
  cookies?: Record<string, string>;
  error?: string;
}

/**
 * SSO Authentication configuration
 */
export interface SSOAuthConfig {
  codeMieUrl: string;
  timeout?: number;
}

/**
 * Stored SSO credentials
 */
export interface SSOCredentials {
  cookies: Record<string, string>;
  apiUrl: string;
  expiresAt: number;
}

/**
 * Codemie SSO Authentication
 *
 * Provides browser-based SSO authentication for Codemie provider
 */
export class CodemieSSO {
  private server?: Server;
  private callbackResult?: SSOAuthResult;
  private codeMieUrl!: string;
  private abortController?: AbortController;
  private isAuthenticating = false;

  /**
   * Authenticate via browser SSO
   */
  async authenticate(config: SSOAuthConfig): Promise<SSOAuthResult> {
    this.codeMieUrl = config.codeMieUrl;
    this.isAuthenticating = true;
    this.abortController = new AbortController();

    // Register signal handlers for graceful termination
    const sigintHandler = () => {
      if (this.isAuthenticating) {
        console.log(chalk.yellow('\n⚠️  Authentication cancelled by user'));
        this.abortController?.abort();
      }
    };

    const sigtermHandler = () => {
      if (this.isAuthenticating) {
        console.log(chalk.yellow('\n⚠️  Authentication terminated'));
        this.abortController?.abort();
      }
    };

    process.once('SIGINT', sigintHandler);
    process.once('SIGTERM', sigtermHandler);

    try {
      // 1. Start local callback server
      const port = await this.startLocalServer();

      // 2. Construct SSO URL
      const codeMieBase = this.ensureApiBase(config.codeMieUrl);
      const ssoUrl = `${codeMieBase}/v1/auth/login/${port}`;

      // 3. Launch browser
      console.log(chalk.white(`Opening browser for authentication...`));
      console.log(chalk.dim(`  → ${ssoUrl}`));
      await open(ssoUrl);

      // 4. Wait for callback with timeout and abort signal
      const result = await this.waitForCallback(
        config.timeout || 120000,
        this.abortController.signal
      );

      // 5. Store credentials if successful
      if (result.success && result.apiUrl && result.cookies) {
        const credentials: SSOCredentials = {
          cookies: result.cookies,
          apiUrl: result.apiUrl,
          expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
        };

        const { CredentialStore } = await import('../../auth/CredentialStore.js');
        const store = CredentialStore.getInstance();
        await store.storeSSOCredentials(credentials, this.codeMieUrl);

        console.log(chalk.green('\n✓ Authentication successful'));
        console.log(chalk.dim(`  API URL: ${result.apiUrl}`));
        console.log(chalk.dim(`  Credentials stored (expires in 24h)`));
      }

      return result;

    } catch (error) {
      // Handle abort as user cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Authentication cancelled by user'
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.isAuthenticating = false;

      // Remove signal handlers
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);

      this.cleanup();
    }
  }

  /**
   * Get stored SSO credentials
   */
  async getStoredCredentials(url?: string): Promise<SSOCredentials | null> {
    const { CredentialStore } = await import('../../auth/CredentialStore.js');
    const store = CredentialStore.getInstance();
    return store.retrieveSSOCredentials(url);
  }

  /**
   * Clear stored credentials
   */
  async clearStoredCredentials(baseUrl?: string): Promise<void> {
    const { CredentialStore } = await import('../../auth/CredentialStore.js');
    const store = CredentialStore.getInstance();
    await store.clearSSOCredentials(baseUrl);
  }

  /**
   * Ensure API base URL has correct format
   */
  private ensureApiBase(rawUrl: string): string {
    let base = rawUrl.replace(/\/$/, '');
    // If user entered only host, append the known API context
    if (!/\/code-assistant-api(\/|$)/i.test(base)) {
      base = `${base}/code-assistant-api`;
    }
    return base;
  }

  /**
   * Start local HTTP server for OAuth callback
   */
  private startLocalServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      let serverPort: number | undefined;

      this.server = createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: Missing URL');
          return;
        }

        // Use locally scoped port from closure
        if (!serverPort) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error: Server not ready');
          return;
        }

        const url = new URL(req.url, `http://localhost:${serverPort}`);

        // Handle the OAuth callback
        this.handleCallback(url).then(result => {
          this.callbackResult = result;

          // Send success page
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="UTF-8">
                <title>Codemie Authentication</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .success { color: #28a745; }
                  .error { color: #dc3545; }
                </style>
              </head>
              <body>
                <h2 class="${result.success ? 'success' : 'error'}">
                  ${result.success ? '✅ Authentication Successful' : '❌ Authentication Failed'}
                </h2>
                <p>You can close this window and return to your terminal.</p>
                ${result.error ? `<p class="error">Error: ${result.error}</p>` : ''}
              </body>
            </html>
          `);

          // Close server safely
          if (this.server) {
            this.server.close();
          }
        }).catch(error => {
          this.callbackResult = { success: false, error: error.message };
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="UTF-8">
                <title>Codemie Authentication Error</title>
              </head>
              <body>
                <h2>❌ Authentication Failed</h2>
                <p>Error: ${error.message}</p>
                <p>You can close this window and return to your terminal.</p>
              </body>
            </html>
          `);
          if (this.server) {
            this.server.close();
          }
        });
      });

      this.server.listen(0, () => {
        const address = this.server!.address();
        serverPort = typeof address === 'object' && address ? address.port : 0;
        resolve(serverPort);
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Handle OAuth callback from browser
   */
  private async handleCallback(url: URL): Promise<SSOAuthResult> {
    try {
      const query = url.searchParams;
      let raw = query.get('token') || query.get('auth') || query.get('data');

      if (!raw) {
        // Try to extract from URL-encoded query
        const decoded = decodeURIComponent(url.search);
        const match = /(?:^|[?&])token=([^&]+)/.exec(decoded);
        if (match && match[1]) raw = match[1];
      }

      if (!raw) {
        throw new Error('Missing token parameter in OAuth callback');
      }

      // Decode base64 token
      const token = JSON.parse(Buffer.from(raw, 'base64').toString('ascii'));

      if (!token.cookies) {
        throw new Error('Token missing cookies field');
      }

      // Try to fetch config.js to resolve actual API URL
      let apiUrl = this.ensureApiBase(this.codeMieUrl);
      try {
        const configResponse = await fetch(`${apiUrl}/config.js`, {
          headers: {
            'cookie': Object.entries(token.cookies)
              .map(([key, value]) => `${key}=${value}`)
              .join(';')
          }
        });

        if (configResponse.ok) {
          const configText = await configResponse.text();
          const viteApiMatch = /VITE_API_URL:\s*"([^"]+)"/.exec(configText);
          if (viteApiMatch && viteApiMatch[1]) {
            apiUrl = viteApiMatch[1].replace(/\/$/, '');
          }
        }
      } catch {
        // Silently fallback to default API URL
      }

      return {
        success: true,
        apiUrl,
        cookies: token.cookies
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Wait for OAuth callback with timeout and abort support
   */
  private async waitForCallback(
    timeout: number,
    abortSignal: AbortSignal
  ): Promise<SSOAuthResult> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let pollInterval: NodeJS.Timeout | undefined;

      // Handle abort signal
      const abortHandler = () => {
        if (timer) clearTimeout(timer);
        if (pollInterval) clearInterval(pollInterval);
        reject(new Error('AbortError'));
      };

      // Handle timeout
      timer = setTimeout(() => {
        if (pollInterval) clearInterval(pollInterval);
        abortSignal.removeEventListener('abort', abortHandler);
        reject(new Error('Authentication timeout - no response received'));
      }, timeout);

      // Register abort handler
      if (abortSignal.aborted) {
        clearTimeout(timer);
        reject(new Error('AbortError'));
        return;
      }
      abortSignal.addEventListener('abort', abortHandler);

      // Poll for callback result
      pollInterval = setInterval(() => {
        if (this.callbackResult) {
          clearTimeout(timer);
          clearInterval(pollInterval);
          abortSignal.removeEventListener('abort', abortHandler);
          resolve(this.callbackResult);
        }
      }, 100);
    });
  }

  /**
   * Cleanup server resources
   */
  private cleanup(): void {
    if (this.server) {
      this.server.closeAllConnections?.();
      this.server.close();
      delete this.server;
    }

    this.callbackResult = undefined;
    this.abortController = undefined;
  }
}
