import chalk from 'chalk';
import type { TokenSet, UserProfile, AuthState } from './types.js';
import { saveTokenSet, loadTokenSet, deleteTokenSet } from './TokenStore.js';
import { DeviceFlow } from './DeviceFlow.js';
import { OAuthClient } from './OAuthClient.js';
import { TokenRefresh } from './TokenRefresh.js';
import { isTokenExpired, extractUserProfile, extractTier } from './JWTDecoder.js';
import { AuthError } from '../utils/errors.js';

const DEFAULT_CLIENT_ID = 'epam-cli';
const DEFAULT_SCOPE = 'openid profile email offline_access';

export class AuthManager {
  private tokenRefresh: TokenRefresh;
  private deviceFlow: DeviceFlow;
  private oauthClient: OAuthClient;

  constructor(private readonly backendUrl: string) {
    this.tokenRefresh = new TokenRefresh(backendUrl, DEFAULT_CLIENT_ID);
    this.deviceFlow = new DeviceFlow({
      backendUrl,
      clientId: DEFAULT_CLIENT_ID,
      scope: DEFAULT_SCOPE,
    });
    this.oauthClient = new OAuthClient(backendUrl, DEFAULT_CLIENT_ID, DEFAULT_SCOPE);
  }

  async login(opts: { browser?: boolean } = {}): Promise<UserProfile> {
    let tokenSet: TokenSet;

    if (opts.browser) {
      console.log(chalk.cyan('Opening browser for authentication...'));
      tokenSet = await this.oauthClient.login();
    } else {
      // Device flow (default)
      const deviceAuth = await this.deviceFlow.startFlow();
      const uri = deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri;
      console.log(chalk.bold('\nTo authenticate, open this URL in your browser:'));
      console.log(chalk.cyan(`  ${uri}`));
      console.log(chalk.bold('\nOr visit:'), chalk.cyan(deviceAuth.verificationUri));
      console.log(chalk.bold('And enter code:'), chalk.yellow.bold(deviceAuth.userCode));
      console.log(chalk.dim('\nWaiting for authorization...'));

      tokenSet = await this.deviceFlow.pollForToken(
        deviceAuth.deviceCode,
        deviceAuth.interval
      );
    }

    await saveTokenSet(tokenSet);
    const user = extractUserProfile(tokenSet.accessToken);
    if (!user) throw new AuthError('Could not decode user from token');

    const tier = extractTier(tokenSet.accessToken) ?? 'free';
    console.log(chalk.green(`\nLogged in as ${user.email} (${tier} tier)`));
    return user;
  }

  async logout(): Promise<void> {
    await deleteTokenSet();
  }

  async getValidToken(): Promise<string> {
    const tokenSet = await loadTokenSet();
    if (!tokenSet) {
      throw new AuthError('Not authenticated. Run `epam login` first.');
    }

    if (isTokenExpired(tokenSet.accessToken, 60)) {
      const refreshed = await this.tokenRefresh.refresh(tokenSet);
      await saveTokenSet(refreshed);
      return refreshed.accessToken;
    }

    return tokenSet.accessToken;
  }

  async getUser(): Promise<UserProfile | null> {
    const tokenSet = await loadTokenSet();
    if (!tokenSet) return null;
    return extractUserProfile(tokenSet.accessToken);
  }

  async getState(): Promise<AuthState> {
    const tokenSet = await loadTokenSet();
    if (!tokenSet) return { status: 'unauthenticated' };

    const user = extractUserProfile(tokenSet.accessToken);
    if (!user) return { status: 'unauthenticated' };

    return { status: 'authenticated', tokenSet, user };
  }

  async isAuthenticated(): Promise<boolean> {
    const state = await this.getState();
    return state.status === 'authenticated';
  }

  getTier(): Promise<string> {
    return loadTokenSet().then(ts => {
      if (!ts) return 'free';
      return extractTier(ts.accessToken) ?? 'free';
    });
  }
}
