import os from 'os';
import path from 'path';

export type Platform = 'darwin' | 'linux' | 'win32';

export function getPlatform(): Platform {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
}

export function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const release = os.release().toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function getHomeDir(): string {
  return os.homedir();
}

export function getEpamGlobalDir(): string {
  return path.join(getHomeDir(), '.epam');
}

export function getEpamProjectDir(projectRoot: string): string {
  return path.join(projectRoot, '.epam');
}

export function supportsKeytar(): boolean {
  return !isWSL() && getPlatform() !== 'linux';
}

export const IS_TTY = Boolean(process.stdout.isTTY);
export const IS_PIPE_MODE = !IS_TTY;
