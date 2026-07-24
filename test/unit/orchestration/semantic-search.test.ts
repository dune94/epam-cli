/**
 * semantic-search.js — real end-to-end coverage of the safe, key-independent
 * paths. Genuinely untested before this (zero test files referenced it),
 * despite being wired into contextualize-stories.sh for brownfield CPA.
 *
 * Scope note: this script makes REAL OpenAI embedding API calls when
 * EPAM_API_KEY_OPENAI/OPENAI_API_KEY is set. Tests here deliberately force
 * the key unset — the documented, safe fallback behavior ("no key → []",
 * caller falls back to tfidf.js) — rather than mocking a live paid API or
 * intercepting the hardcoded api.openai.com hostname. That's a real,
 * accepted coverage boundary: no test in this repo should ever risk a live
 * paid external API call.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/lib/semantic-search.js');
const NODE = process.execPath;

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeKbDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-search-kb-'));
  cleanupDirs.push(dir);
  return dir;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    // Always force keys unset unless the test explicitly overrides —
    // never let an ambient key in this dev shell trigger a real API call.
    env: { ...process.env, EPAM_API_KEY_OPENAI: '', OPENAI_API_KEY: '', ...env },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status ?? -1 };
}

describe('semantic-search.js — no-API-key fallback (the default, safe path)', () => {
  it('exits 0 with [] when no OpenAI key is set at all, regardless of a real KB corpus existing', () => {
    const kbDir = makeKbDir();
    writeFileSync(join(kbDir, 'notes.md'), '# Discounts\nPromo code discount amount handling.\n'.repeat(3));

    const { stdout, exitCode } = run(['--kb-dir', kbDir, '--query', 'promo discount amount']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('[]');
  });

  it('never attempts a network call when no key is set (no hang, fast exit)', () => {
    const kbDir = makeKbDir();
    const start = Date.now();
    const { exitCode } = run(['--kb-dir', kbDir, '--query', 'anything']);
    const elapsed = Date.now() - start;
    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(5000); // real network calls would take far longer or hang
  });
});

describe('semantic-search.js — CLI argument handling and error paths', () => {
  it('exits 1 with a usage message when --query is missing', () => {
    const kbDir = makeKbDir();
    const { exitCode, stderr } = run(['--kb-dir', kbDir]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage:/);
  });

  it('exits 0 with [] when --kb-dir does not exist (no key set, so this never even reaches corpus loading behavior that matters)', () => {
    const { stdout, exitCode } = run(['--kb-dir', '/definitely/does/not/exist', '--query', 'x']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('[]');
  });

  it('exits 0 with [] when --kb-dir is omitted entirely', () => {
    const { stdout, exitCode } = run(['--query', 'x']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('[]');
  });

  it('accepts --extra-docs and --vector-store and --assets flags without error (still short-circuits on missing key)', () => {
    const kbDir = makeKbDir();
    const extraDoc = join(kbDir, 'extra.md');
    writeFileSync(extraDoc, 'extra doc content\n');
    const { stdout, exitCode } = run([
      '--kb-dir', kbDir,
      '--query', 'x',
      '--extra-docs', extraDoc,
      '--vector-store', join(kbDir, 'store.json'),
      '--assets', join(kbDir, 'assets.json'),
      '--top', '3',
      '--chunk-size', '10',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('[]');
  });

  it('run 10x in a row — deterministically returns [] with no key, never crashes, never hangs', () => {
    const kbDir = makeKbDir();
    writeFileSync(join(kbDir, 'notes.md'), 'content\n'.repeat(5));
    const outcomes: { exitCode: number; stdout: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const { exitCode, stdout } = run(['--kb-dir', kbDir, '--query', 'content']);
      outcomes.push({ exitCode, stdout: stdout.trim() });
    }
    const failures = outcomes.filter(o => o.exitCode !== 0 || o.stdout !== '[]');
    expect(failures, `${failures.length}/10 failed: ${JSON.stringify(outcomes)}`).toHaveLength(0);
  }, 30000);
});
