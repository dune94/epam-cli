/**
 * scan-secrets.sh must actually DETECT secrets — proven by running it.
 *
 * `secret-scan-gate.test.ts` has 15 tests and zero `spawnSync`: it reads the scanner's
 * source and asserts patterns appear in it. That cannot prove the scanner works, and it is
 * specifically blind to the risk of commit dc0b7a4, which rewrote the test fixtures'
 * credential literals into non-contiguous pieces so GitHub's secret scanning would stop
 * firing on them. If that rewrite had also stopped the SCANNER matching, every existing
 * test would still pass — the fixtures are only compared against the source text.
 *
 * So this file runs the real script against a real git repo with a real staged diff.
 *
 * The credential literals here are assembled at runtime from fragments for the same reason
 * dc0b7a4 split them: a contiguous literal in a committed file trips upstream secret
 * scanners on FORMAT alone, even when the value is deliberately fake. The scanner under
 * test sees the reassembled string, so detection is exercised exactly as in production.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCANNER = join(__dirname, '../../../orchestrations/scripts/scan-secrets.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway git repo with `files` staged. */
function repoWithStaged(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 20000 });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  // A base commit, so the staged diff is a real diff rather than the initial import.
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  git('add', '-A');
  return dir;
}

function scan(dir: string) {
  const r = spawnSync('bash', [SCANNER, dir], { encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Built at runtime — never a contiguous literal in this file. */
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const PEM_HEADER = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');

describe('the scanner runs and passes clean code', () => {
  it('exits 0 when the staged diff holds no credentials', () => {
    const { status, out } = scan(
      repoWithStaged({ 'src/ok.ts': 'export const greet = () => "hello";\n' }),
    );
    expect(status, `clean code was flagged — the gate would block every commit:\n${out}`).toBe(0);
  });

  it('exits 0 for a file that merely mentions the WORD key', () => {
    const { status } = scan(
      repoWithStaged({ 'src/k.ts': 'const keyName = "primary"; // key lookup\n' }),
    );
    expect(status).toBe(0);
  });
});

describe('the scanner still DETECTS real credential formats', () => {
  it('REGRESSION GUARD for dc0b7a4: an AWS access key id is caught', () => {
    const { status, out } = scan(repoWithStaged({ 'src/c.ts': `const k = "${AWS_KEY}";\n` }));
    expect(
      status,
      'the scanner did not flag an AWS access key id. dc0b7a4 split this literal in the ' +
        'FIXTURES so upstream scanning would stop alerting; if that also broke DETECTION, ' +
        'no existing test would notice — they only read the scanner source.',
    ).not.toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });

  it('a private key block is caught', () => {
    const { status } = scan(repoWithStaged({ 'src/id_rsa': `${PEM_HEADER}\nMIIEow==\n` }));
    expect(status, 'a PEM private-key block was not flagged').not.toBe(0);
  });

  /**
   * The scanner names the PATTERN it matched, which is its actual contract today:
   *   SECRET_SCAN: possible credential(s) detected in staged changes: AWS Access Key ID
   *
   * It does NOT name the offending FILE. That is a real operability gap — a blocked
   * commit makes the operator hunt for the line — but it is a pre-existing behaviour,
   * not a regression, so it is recorded rather than silently changed here. If the
   * scanner is later taught to name the file, tighten this to assert the path.
   */
  it('says WHAT it matched, so the block is diagnosable', () => {
    const { out } = scan(repoWithStaged({ 'src/leak.ts': `const k = "${AWS_KEY}";\n` }));
    expect(out, 'the scanner blocked a commit without saying what it matched')
      .toMatch(/AWS Access Key ID/i);
    expect(out, 'the block gives no remediation guidance').toMatch(/environment variable|secret store/i);
  });

  it('catches a credential added ANYWHERE in the staged set, not just the first file', () => {
    const { status } = scan(
      repoWithStaged({
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 2;\n',
        'src/c.ts': `const k = "${AWS_KEY}";\n`,
      }),
    );
    expect(status, 'only the first staged file was scanned').not.toBe(0);
  });
});
