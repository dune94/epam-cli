import crypto from 'crypto';
import http from 'http';
import { URL } from 'url';
import open from 'open';
import type { TokenSet } from './types.js';
import { AuthError } from '../utils/errors.js';

const CALLBACK_PORT = 9876;
const CALLBACK_PATH = '/callback';

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export class OAuthClient {
  constructor(
    private readonly backendUrl: string,
    private readonly clientId: string,
    private readonly scope: string = 'openid profile email offline_access'
  ) {}

  async login(): Promise<TokenSet> {
    const { verifier, challenge } = generatePKCE();
    const state = generateState();
    const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

    const authUrl = new URL(`${this.backendUrl}/oauth/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', this.scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const code = await this.startCallbackServer(authUrl.toString(), state);
    return this.exchangeCode(code, verifier, redirectUri);
  }

  private startCallbackServer(authUrl: string, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
        if (url.pathname !== CALLBACK_PATH) return;

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html><html><body>
          <h2>${error ? 'Authorization failed' : 'Authorization successful!'}</h2>
          <p>${error ? error : 'You can close this tab and return to your terminal.'}</p>
          </body></html>
        `);

        server.close();

        if (error) return reject(new AuthError(`OAuth error: ${error}`));
        if (state !== expectedState) return reject(new AuthError('State mismatch'));
        if (!code) return reject(new AuthError('No authorization code received'));

        resolve(code);
      });

      server.listen(CALLBACK_PORT, () => {
        open(authUrl).catch(() => {
          console.log(`Open this URL in your browser:\n${authUrl}`);
        });
      });

      server.on('error', reject);

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new AuthError('Browser login timed out'));
      }, 300000);
    });
  }

  private async exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string
  ): Promise<TokenSet> {
    const res = await fetch(`${this.backendUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AuthError(`Token exchange failed: ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    return {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string | undefined,
      idToken: data.id_token as string | undefined,
      expiresAt: Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
      tokenType: (data.token_type as string | undefined) ?? 'Bearer',
      scope: data.scope as string | undefined,
    };
  }
}
