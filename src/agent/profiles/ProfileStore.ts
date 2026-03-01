import fs from 'fs/promises';
import path from 'path';
import { getEpamGlobalDir } from '../../utils/platform.js';
import type { Profile, ProfileWithSource } from './types.js';

const PROFILES_SUBDIR = 'profiles';

/**
 * ProfileStore handles reading, writing, listing, and deleting agent profiles.
 * Profiles are stored in:
 * - Global: ~/.epam/profiles/
 * - Project-local: .epam/profiles/ (takes precedence when loading by name)
 */
export class ProfileStore {
  private globalProfilesDir: string;
  private localProfilesDir: string | null;

  constructor(projectRoot: string | null = null) {
    this.globalProfilesDir = path.join(getEpamGlobalDir(), PROFILES_SUBDIR);
    this.localProfilesDir = projectRoot
      ? path.join(projectRoot, '.epam', PROFILES_SUBDIR)
      : null;
  }

  /**
   * List all available profiles (global + local).
   * Project-local profiles are listed first.
   */
  async list(): Promise<ProfileWithSource[]> {
    const profiles: ProfileWithSource[] = [];

    // Load local profiles first (if in a project)
    if (this.localProfilesDir) {
      const localProfiles = await this.listFromDir(this.localProfilesDir, 'local');
      profiles.push(...localProfiles);
    }

    // Load global profiles
    const globalProfiles = await this.listFromDir(this.globalProfilesDir, 'global');

    // Filter out global profiles with same name as local (local takes precedence)
    const localNames = new Set(profiles.map(p => p.name));
    for (const globalProfile of globalProfiles) {
      if (!localNames.has(globalProfile.name)) {
        profiles.push(globalProfile);
      }
    }

    return profiles;
  }

  /**
   * Load a profile by name. Project-local takes precedence over global.
   */
  async load(name: string): Promise<ProfileWithSource | null> {
    // Try local first
    if (this.localProfilesDir) {
      const localProfile = await this.loadFromDir(name, this.localProfilesDir, 'local');
      if (localProfile) return localProfile;
    }

    // Fall back to global
    return this.loadFromDir(name, this.globalProfilesDir, 'global');
  }

  /**
   * Save a profile. Saves to project-local if in a project, otherwise global.
   */
  async save(profile: Profile, location: 'global' | 'local' = 'local'): Promise<string> {
    const targetDir = location === 'local' && this.localProfilesDir
      ? this.localProfilesDir
      : this.globalProfilesDir;

    await fs.mkdir(targetDir, { recursive: true });

    const filename = `${profile.name}.json`;
    const filePath = path.join(targetDir, filename);

    await fs.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf-8');

    return filePath;
  }

  /**
   * Delete a profile by name. Removes from both local and global if present.
   */
  async delete(name: string): Promise<{ deleted: string[]; notFound: boolean }> {
    const deleted: string[] = [];
    let foundAny = false;

    // Try local
    if (this.localProfilesDir) {
      const localPath = path.join(this.localProfilesDir, `${name}.json`);
      if (await this.fileExists(localPath)) {
        await fs.unlink(localPath);
        deleted.push(localPath);
        foundAny = true;
      }
    }

    // Try global
    const globalPath = path.join(this.globalProfilesDir, `${name}.json`);
    if (await this.fileExists(globalPath)) {
      await fs.unlink(globalPath);
      deleted.push(globalPath);
      foundAny = true;
    }

    return { deleted, notFound: !foundAny };
  }

  /**
   * List profiles from a specific directory.
   */
  private async listFromDir(
    dir: string,
    source: 'global' | 'local'
  ): Promise<ProfileWithSource[]> {
    try {
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir);
      const jsonFiles = entries.filter(e => e.endsWith('.json'));

      const profiles: ProfileWithSource[] = [];
      for (const file of jsonFiles) {
        const filePath = path.join(dir, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const profile = JSON.parse(content) as Profile;
          profiles.push({
            ...profile,
            source,
            filePath,
          });
        } catch {
          // Skip malformed files
          continue;
        }
      }

      return profiles;
    } catch {
      return [];
    }
  }

  /**
   * Load a single profile from a directory.
   */
  private async loadFromDir(
    name: string,
    dir: string,
    source: 'global' | 'local'
  ): Promise<ProfileWithSource | null> {
    const filePath = path.join(dir, `${name}.json`);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const profile = JSON.parse(content) as Profile;
      return {
        ...profile,
        source,
        filePath,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
