/**
 * THE WORD DOES NOT APPEAR IN THIS PROJECT.
 *
 * Not as a provider, not as a model id, not in a comment, not in a config value. OpenRouter
 * replaced it completely. Anything less is a partial state, and a partial state is what made the
 * operator's instruction impossible to follow: the dispatch accepted only qwen and rejected
 * openrouter, so a run launched as asked died at startup.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');

/** Every occurrence in the working tree, excluding history and third-party code. */
function occurrences(): string[] {
  try {
    const out = execFileSync('grep', [
      '-rniI', 'qwen', '.',
      '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=logs',
      '--exclude-dir=dist', '--exclude-dir=.venv-deepeval', '--exclude-dir=reports',
      '--exclude=qwen-is-fully-deprecated.test.ts',
    ], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean);
  } catch (e: any) {
    // grep exits 1 when it finds nothing, which is the outcome this test wants.
    if (e && e.status === 1) return [];
    throw e;
  }
}

describe('the word qwen does not appear in this project', () => {
  it('grep finds nothing', () => {
    const found = occurrences();
    const sample = found.slice(0, 25).join('\n');
    expect(found, `${found.length} occurrence(s) remain:\n${sample}`).toEqual([]);
  }, 120_000);
});
