/**
 * brownfield-context.js — real end-to-end coverage.
 *
 * Genuinely untested before this (zero test files referenced it), despite
 * being actively wired into the pipeline via contextualize-stories.sh.
 * Real subprocess execution against real git repos/fixture files throughout
 * — no mocking of the script itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/lib/brownfield-context.js');
const NODE = process.execPath;

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(withGit = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'brownfield-context-'));
  cleanupDirs.push(dir);
  if (withGit) {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, '.gitkeep'), '');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir });
  }
  return dir;
}

function addFile(repo: string, rel: string, content: string) {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(repo: string) {
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: repo });
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env, JIRA_URL: '', JIRA_EMAIL: '', JIRA_TOKEN: '', ...env },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status ?? -1 };
}

describe('brownfield-context.js — Stage 1: git repo TF-IDF chunking', () => {
  it('finds and scores a real chunk matching the query, from a committed git file', () => {
    const repo = makeRepo();
    addFile(repo, 'src/discount.ts', `
      // Applies promo code discount amounts to order line items.
      export function applyDiscount(order, promo) {
        return order.total - promo.amount;
      }
    `.repeat(1));
    commitAll(repo);

    const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'promo code discount amount']);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('git:src/discount.ts');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns results sorted descending by score', () => {
    const repo = makeRepo();
    addFile(repo, 'src/strong.ts', 'promo promo promo discount discount discount amount amount amount\n'.repeat(3));
    addFile(repo, 'src/weak.ts', 'promo something unrelated entirely different\n'.repeat(3));
    commitAll(repo);

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    const results = JSON.parse(stdout);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('respects --top to cap the number of results', () => {
    const repo = makeRepo();
    for (let i = 0; i < 10; i++) {
      addFile(repo, `src/file${i}.ts`, `promo discount amount value ${i}\n`.repeat(3));
    }
    commitAll(repo);

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount', '--top', '3']);
    const results = JSON.parse(stdout);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('skips files with excluded extensions (e.g. .png, .lock)', () => {
    const repo = makeRepo();
    addFile(repo, 'assets/logo.png', 'promo discount amount binary-ish content\n');
    addFile(repo, 'package-lock.json', '{"promo":"discount amount"}\n'); // .json IS included, but this tests non-included ext below
    addFile(repo, 'notes.xyz', 'promo discount amount\n');
    commitAll(repo);

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source.includes('.png'))).toBe(false);
    expect(results.some((r: any) => r.source.includes('.xyz'))).toBe(false);
  });

  it('skips files inside SKIP_DIRS (node_modules, .git, dist, etc.)', () => {
    const repo = makeRepo();
    addFile(repo, 'node_modules/pkg/index.ts', 'promo discount amount\n'.repeat(3));
    addFile(repo, 'dist/bundle.js', 'promo discount amount\n'.repeat(3));
    addFile(repo, 'src/real.ts', 'promo discount amount\n'.repeat(3));
    commitAll(repo);

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source.includes('node_modules'))).toBe(false);
    expect(results.some((r: any) => r.source.includes('dist/'))).toBe(false);
    expect(results.some((r: any) => r.source === 'git:src/real.ts')).toBe(true);
  });

  it('skips files larger than --max-file-kb', () => {
    const repo = makeRepo();
    const bigContent = 'promo discount amount\n'.repeat(20000); // well over 1KB
    addFile(repo, 'src/huge.ts', bigContent);
    addFile(repo, 'src/small.ts', 'promo discount amount\n');
    commitAll(repo);

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount', '--max-file-kb', '1']);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source === 'git:src/huge.ts')).toBe(false);
  });

  it('falls back to a directory walk when repo-root is not a git repo', () => {
    const repo = makeRepo(false); // no git init
    addFile(repo, 'src/plain.ts', 'promo discount amount\n'.repeat(3));

    const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source === 'git:src/plain.ts')).toBe(true);
  });

  it('returns [] when no chunk matches the query at all (score 0 everywhere)', () => {
    const repo = makeRepo();
    addFile(repo, 'src/unrelated.ts', 'export const x = 1;\n');
    commitAll(repo);

    const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'zzz_no_match_qqq_xxx']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe('brownfield-context.js — Stage 2: stub Jira/Confluence loading', () => {
  it('loads and scores stub Jira issues from .epam/brownfield/jira.json', () => {
    const repo = makeRepo();
    addFile(repo, '.epam/brownfield/jira.json', JSON.stringify([
      { key: 'AMSD-1', summary: 'Promo code discount missing', description: 'discount amount not shown', acceptanceCriteria: ['show discount amount'] },
    ]));

    const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'promo code discount amount']);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source === 'stub:jira:AMSD-1')).toBe(true);
  });

  it('loads and scores stub Confluence markdown from .epam/brownfield/confluence.md', () => {
    const repo = makeRepo();
    addFile(repo, '.epam/brownfield/confluence.md', 'This document describes promo code discount amount handling.\n'.repeat(3));

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source === 'stub:confluence')).toBe(true);
  });

  it('uses "stub:jira" prefix (not live "jira") when JIRA_URL/EMAIL/TOKEN are not all set', () => {
    const repo = makeRepo();
    addFile(repo, '.epam/brownfield/jira.json', JSON.stringify([
      { key: 'AMSD-2', summary: 'promo discount amount', description: '', acceptanceCriteria: [] },
    ]));

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    const results = JSON.parse(stdout);
    const jiraResult = results.find((r: any) => r.source.includes('AMSD-2'));
    expect(jiraResult.source).toBe('stub:jira:AMSD-2');
  });

  it('is a no-op (no stub chunks) when .epam/brownfield does not exist at all', () => {
    const repo = makeRepo();
    addFile(repo, 'src/real.ts', 'promo discount amount\n');
    commitAll(repo);

    const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.every((r: any) => !r.source.startsWith('stub:'))).toBe(true);
  });

  it('handles a malformed jira.json (invalid JSON) without crashing — logs to stderr, continues', () => {
    const repo = makeRepo();
    addFile(repo, '.epam/brownfield/jira.json', '{not valid json!!!');

    const { exitCode, stderr } = run(['--repo-root', repo, '--query', 'promo discount amount']);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/jira\.json parse error/);
  });

  it('respects a custom --stub-dir override', () => {
    const repo = makeRepo();
    const customStubDir = join(repo, 'custom-stubs');
    mkdirSync(customStubDir, { recursive: true });
    writeFileSync(join(customStubDir, 'jira.json'), JSON.stringify([
      { key: 'CUSTOM-1', summary: 'promo discount amount', description: '', acceptanceCriteria: [] },
    ]));

    const { stdout } = run(['--repo-root', repo, '--query', 'promo discount amount', '--stub-dir', customStubDir]);
    const results = JSON.parse(stdout);
    expect(results.some((r: any) => r.source === 'stub:jira:CUSTOM-1')).toBe(true);
  });
});

describe('brownfield-context.js — CLI argument handling and error paths', () => {
  it('exits 1 with a usage message when --query is missing', () => {
    const repo = makeRepo();
    const { exitCode, stderr } = run(['--repo-root', repo]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Usage:/);
  });

  it('exits 0 with [] when --repo-root does not exist (non-fatal)', () => {
    const { stdout, exitCode, stderr } = run(['--repo-root', '/definitely/does/not/exist/anywhere', '--query', 'x']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('[]');
    expect(stderr).toMatch(/repo root not found/);
  });

  it('exits 0 with [] when --repo-root is missing entirely', () => {
    const { stdout, exitCode } = run(['--query', 'x']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('[]');
  });

  it('exits 0 with [] when the query has no usable tokens (e.g. only punctuation/short words)', () => {
    const repo = makeRepo();
    addFile(repo, 'src/a.ts', 'promo discount amount\n');
    commitAll(repo);
    const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'a. ,! ? to']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('run 10x in a row against the same fixture — deterministic scoring every time', () => {
    const repo = makeRepo();
    addFile(repo, 'src/discount.ts', 'promo code discount amount applied to order\n'.repeat(3));
    commitAll(repo);

    const scores: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { stdout, exitCode } = run(['--repo-root', repo, '--query', 'promo discount amount']);
      expect(exitCode).toBe(0);
      const results = JSON.parse(stdout);
      scores.push(results[0]?.score ?? -1);
    }
    const uniqueScores = new Set(scores);
    expect(uniqueScores.size).toBe(1); // fully deterministic — same score every time
    expect(scores[0]).toBeGreaterThan(0);
  }, 30000);
});
