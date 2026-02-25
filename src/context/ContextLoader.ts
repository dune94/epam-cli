import fs from 'fs/promises';
import path from 'path';
import { pathExists } from '../utils/fs.js';

export async function loadContextFile(contextFilePath: string): Promise<string> {
  if (!contextFilePath) return '';

  const resolved = path.resolve(contextFilePath);
  if (!(await pathExists(resolved))) return '';

  try {
    const content = await fs.readFile(resolved, 'utf-8');
    return content.trim();
  } catch {
    return '';
  }
}
