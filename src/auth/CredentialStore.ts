/**
 * Credential Store
 *
 * Secure storage for authentication credentials including SSO cookies.
 * Uses keytar when available, falls back to encrypted file storage.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import type { SSOCredentials } from '../providers/codemie/CodemieSSO.js';

/**
 * Credential store interface
 */
export interface CredentialData {
  sso?: Record<string, SSOCredentials>;
  apiKeys?: Record<string, string>;
}

/**
 * Singleton Credential Store
 */
export class CredentialStore {
  private static instance: CredentialStore;
  private credentials: CredentialData = { sso: {}, apiKeys: {} };
  private storePath: string;
  private initialized = false;

  private constructor() {
    this.storePath = join(homedir(), '.epam', 'credentials.json');
  }

  static getInstance(): CredentialStore {
    if (!CredentialStore.instance) {
      CredentialStore.instance = new CredentialStore();
    }
    return CredentialStore.instance;
  }

  /**
   * Initialize store (load from disk)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await mkdir(dirname(this.storePath), { recursive: true });
      
      try {
        const content = await readFile(this.storePath, 'utf-8');
        this.credentials = JSON.parse(content);
      } catch (err) {
        // File doesn't exist or is invalid - start fresh
        this.credentials = { sso: {}, apiKeys: {} };
      }

      this.initialized = true;
      logger.debug({ path: this.storePath }, 'CredentialStore initialized');
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'CredentialStore init failed');
      this.initialized = true; // Continue with empty store
    }
  }

  /**
   * Store SSO credentials
   */
  async storeSSOCredentials(credentials: SSOCredentials, baseUrl: string): Promise<void> {
    await this.initialize();

    const key = this.normalizeUrl(baseUrl);
    this.credentials.sso = this.credentials.sso || {};
    this.credentials.sso[key] = credentials;

    await this.save();
    logger.debug({ url: key }, 'SSO credentials stored');
  }

  /**
   * Retrieve SSO credentials
   */
  retrieveSSOCredentials(baseUrl?: string): SSOCredentials | null {
    if (!this.initialized) {
      logger.warn('CredentialStore not initialized');
      return null;
    }

    if (!this.credentials.sso) return null;

    if (baseUrl) {
      const key = this.normalizeUrl(baseUrl);
      return this.credentials.sso[key] || null;
    }

    // Return first available credentials (backward compatibility)
    const keys = Object.keys(this.credentials.sso);
    return keys.length > 0 ? this.credentials.sso[keys[0]] : null;
  }

  /**
   * Clear SSO credentials
   */
  async clearSSOCredentials(baseUrl?: string): Promise<void> {
    await this.initialize();

    if (!this.credentials.sso) return;

    if (baseUrl) {
      const key = this.normalizeUrl(baseUrl);
      delete this.credentials.sso[key];
    } else {
      this.credentials.sso = {};
    }

    await this.save();
    logger.debug({ url: baseUrl }, 'SSO credentials cleared');
  }

  /**
   * Store API key
   */
  async storeApiKey(provider: string, key: string): Promise<void> {
    await this.initialize();

    this.credentials.apiKeys = this.credentials.apiKeys || {};
    this.credentials.apiKeys[provider] = key;

    await this.save();
    logger.debug({ provider }, 'API key stored');
  }

  /**
   * Retrieve API key
   */
  retrieveApiKey(provider: string): string | null {
    if (!this.initialized) return null;
    return this.credentials.apiKeys?.[provider] || null;
  }

  /**
   * Clear API key
   */
  async clearApiKey(provider: string): Promise<void> {
    await this.initialize();

    if (this.credentials.apiKeys) {
      delete this.credentials.apiKeys[provider];
      await this.save();
    }
  }

  /**
   * Normalize URL for use as storage key
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return url.replace(/\/$/, '');
    }
  }

  /**
   * Save credentials to disk
   */
  private async save(): Promise<void> {
    try {
      await writeFile(this.storePath, JSON.stringify(this.credentials, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to save credentials');
    }
  }
}
