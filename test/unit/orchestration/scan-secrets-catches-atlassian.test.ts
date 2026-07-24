/**
 * scan-secrets.sh must catch the secret shapes that actually escaped.
 *
 * ESCAPED DEFECT (2026-07-24): a live Atlassian API token
 * (`JIRA_TOKEN=ATATT3xFfGF0...`) sat in `orchestrations/jira/metrolinx.env`,
 * was committed locally, and reached the remote on a push — triggering a
 * secret-scanning alert. The scanner missed it for TWO independent reasons:
 *
 *   1. NO ATLASSIAN PATTERN. It knows AWS/GitHub/Slack/OpenAI/Google shapes but
 *      not Atlassian's `ATATT...` tokens.
 *   2. THE GENERIC RULE REQUIRES QUOTES. Its fallback regex demands
 *      `token = "value"` — so a bare `KEY=value` assignment, i.e. the entire
 *      contents of every .env file, is invisible to it.
 *
 * A third gap is scope and is covered by its own test below: it only inspects
 * `git diff --cached`, so anything already committed but not yet pushed sails
 * past. That is precisely how the token reached the remote — the push carried
 * 14 pre-existing commits that no staged-diff scan would ever look at.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCANNER = join(__dirname, '../../../orchestrations/scripts/scan-secrets.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

function repoWithStaged(file: string, content: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'scan-secrets-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), content);
  git(repo, ['add', file]);
  return repo;
}

/** Returns scanner stdout+stderr and exit code. */
function scan(repo: string): { out: string; code: number } {
  try {
    const out = execFileSync('bash', ['-c', `bash ${JSON.stringify(SCANNER)} ${JSON.stringify(repo)} 2>&1`],
      { encoding: 'utf8' });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 };
  }
}

// A SYNTHETIC token matching Atlassian's shape (ATATT + long body + =CHECKSUM).
// Deliberately built from a repeated dummy body so it can never be confused with,
// or be a fragment of, a real credential — an early draft of this test copied a
// prefix of the real token, which would itself have been a leak.
// Assembled at runtime so this source file never contains a scannable literal,
// and deliberately WITHOUT any dummy/fake marker — the scanner must flag it on
// shape alone, which is the behaviour under test.
const ATLASSIAN = 'ATATT' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0' + '=ZZZZ1111';

describe('scan-secrets.sh — the shapes that actually escaped', () => {
  it('catches a bare unquoted Atlassian token assignment in a .env file', () => {
    const repo = repoWithStaged('orchestrations/jira/metrolinx.env', `JIRA_URL=https://x.atlassian.net\nJIRA_TOKEN=${ATLASSIAN}\n`);
    const { out } = scan(repo);
    expect(out).toMatch(/SECRET_SCAN/);
  });

  it('catches an Atlassian token hardcoded as a JS fallback', () => {
    const repo = repoWithStaged('scripts/jira-proxy.js',
      `const JIRA_TOKEN = process.env.JIRA_TOKEN || '${ATLASSIAN}';\n`);
    const { out } = scan(repo);
    expect(out).toMatch(/SECRET_SCAN/);
  });

  it('catches a bare unquoted generic credential assignment (KEY=longvalue)', () => {
    const secretVal = 's3cr3tvalue' + '_thatislongenough_1234567890';   // runtime-assembled
    const repo = repoWithStaged('config/app.env', `API_SECRET=${secretVal}\n`);
    const { out } = scan(repo);
    expect(out).toMatch(/SECRET_SCAN/);
  });

  it('does NOT flag placeholder templates (.env.example must stay committable)', () => {
    const repo = repoWithStaged('orchestrations/jira/.env.example',
      'JIRA_URL=http://localhost:8080\nJIRA_TOKEN=admin-password-set-during-setup\n');
    const { out } = scan(repo);
    expect(out).not.toMatch(/SECRET_SCAN/);
  });

  it('does NOT flag env-var indirection', () => {
    const repo = repoWithStaged('src/x.js', 'const t = process.env.JIRA_TOKEN || "";\n');
    const { out } = scan(repo);
    expect(out).not.toMatch(/SECRET_SCAN/);
  });

  it('still catches the shapes it already knew (no regression)', () => {
    // Built at runtime: this SOURCE FILE must never contain a scannable secret
    // literal, or the scanner would block every commit of its own test suite.
    const awsKey = 'AKIA' + 'Q7HJ2L9WMN4XPR6B';
    const repo = repoWithStaged('a.txt', `aws = "${awsKey}"\n`);
    expect(scan(repo).out).toMatch(/SECRET_SCAN/);
  });

  it('does NOT flag credential-SHAPED fixtures explicitly marked as dummy', () => {
    // Security tests and .env templates legitimately carry secret-shaped strings.
    const repo = repoWithStaged('t.ts', `const t = 'ATATT-DUMMY-TEST-TOKEN-NOT-REAL=AAAA0000';\n`);
    expect(scan(repo).out).not.toMatch(/SECRET_SCAN/);
  });

  it('can scan a COMMIT RANGE, not just the staged diff — the push path that leaked', () => {
    // The token was already committed when the push happened; a staged-diff-only
    // scanner is blind to exactly that case.
    const repo = mkdtempSync(join(tmpdir(), 'scan-range-'));
    dirs.push(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
    const base = git(repo, ['rev-parse', 'HEAD']).trim();
    mkdirSync(join(repo, 'orchestrations', 'jira'), { recursive: true });
    writeFileSync(join(repo, 'orchestrations', 'jira', 'metrolinx.env'), `JIRA_TOKEN=${ATLASSIAN}\n`);
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'oops']);
    // Nothing staged now — a staged-only scan would report clean.
    const { out } = (() => {
      try {
        return { out: execFileSync('bash',
          ['-c', `bash ${JSON.stringify(SCANNER)} ${JSON.stringify(repo)} ${base}..HEAD 2>&1`],
          { encoding: 'utf8' }) };
      } catch (e: any) { return { out: (e.stdout || '') + (e.stderr || '') }; }
    })();
    expect(out).toMatch(/SECRET_SCAN/);
  });
});
