/**
 * CodeGraph index validity detection — REAL execution of the actual,
 * unmodified isCodeGraphIndexed() (JS) and is_valid_codegraph_db() (bash,
 * extracted by marker) against real fixture files.
 *
 * Built 2026-07-23 after a real Metrolinx run's azure.commerce.cdts repo
 * ended up with a `.codegraph/` directory containing only `.gitignore` —
 * no `codegraph.db` at all — most likely left behind by a killed (SIGKILL)
 * pipeline process interrupting `codegraph init` mid-write (it writes
 * .gitignore before the db). The preflight script's and the JS wrapper's
 * "is indexed" checks both used a plain `[ -f ]` / fs.existsSync — which
 * would have accepted ANY file at that path, including an empty or
 * truncated one left by an interrupted write, as "already indexed" and
 * never re-indexed it. Running `codegraph init` standalone proved the
 * indexer itself works fine (1,205 files, real 25MB db, ~1s) — the bug was
 * purely in the validity check, not the indexer. Fixed by validating the
 * real SQLite magic header ("SQLite format 3\0") instead of just checking
 * the path exists, in both the JS and bash implementations.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const codegraphContext = require('../../../orchestrations/scripts/lib/codegraph-context.js');
const { isCodeGraphIndexed } = codegraphContext;

const PREFLIGHT_SH = join(__dirname, '../../../orchestrations/scripts/codegraph-preflight-index.sh');
const preflightSrc = readFileSync(PREFLIGHT_SH, 'utf8');

function extractIsValidFn(): string {
  const start = preflightSrc.indexOf('is_valid_codegraph_db() {');
  if (start === -1) throw new Error('is_valid_codegraph_db function not found');
  const end = preflightSrc.indexOf('\n}', start) + 2;
  return preflightSrc.slice(start, end);
}
const isValidFnSrc = extractIsValidFn();

function bashIsValid(dbPath: string): boolean {
  const script = `${isValidFnSrc}\nis_valid_codegraph_db "${dbPath}" && echo YES || echo NO`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  return out === 'YES';
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepoDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'codegraph-corrupt-'));
  cleanupDirs.push(d);
  return d;
}

describe('CodeGraph index validity detection (real extracted/exported code)', () => {
  it('a real, valid SQLite db is recognized as indexed (both JS and bash)', () => {
    const repo = makeRepoDir();
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    const dbPath = join(cgDir, 'codegraph.db');
    // Real SQLite files begin with this exact 16-byte magic header.
    const header = Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.alloc(100)]);
    writeFileSync(dbPath, header);
    expect(isCodeGraphIndexed(repo)).toBe(true);
    expect(bashIsValid(dbPath)).toBe(true);
  });

  it('reproduces the exact live failure: .codegraph/ with only .gitignore, no db at all', () => {
    const repo = makeRepoDir();
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    writeFileSync(join(cgDir, '.gitignore'), 'codegraph.db\n');
    // No codegraph.db written — this is exactly the live state found.
    expect(isCodeGraphIndexed(repo)).toBe(false);
    expect(bashIsValid(join(cgDir, 'codegraph.db'))).toBe(false);
  });

  it('an empty (0-byte) db file — a killed process before any bytes flushed — is NOT treated as indexed', () => {
    const repo = makeRepoDir();
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    const dbPath = join(cgDir, 'codegraph.db');
    writeFileSync(dbPath, '');
    expect(isCodeGraphIndexed(repo)).toBe(false);
    expect(bashIsValid(dbPath)).toBe(false);
  });

  it('a truncated db file (partial header, killed mid-write) is NOT treated as indexed', () => {
    const repo = makeRepoDir();
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    const dbPath = join(cgDir, 'codegraph.db');
    writeFileSync(dbPath, Buffer.from('SQLite fo')); // cut off mid-header
    expect(isCodeGraphIndexed(repo)).toBe(false);
    expect(bashIsValid(dbPath)).toBe(false);
  });

  it('a file with plausible-looking content but the wrong header is NOT treated as indexed (not just "is a file")', () => {
    const repo = makeRepoDir();
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    const dbPath = join(cgDir, 'codegraph.db');
    writeFileSync(dbPath, 'not actually a database, just some text\n'.repeat(50));
    expect(isCodeGraphIndexed(repo)).toBe(false);
    expect(bashIsValid(dbPath)).toBe(false);
  });

  it('no .codegraph directory at all is NOT treated as indexed', () => {
    const repo = makeRepoDir();
    expect(existsSync(join(repo, '.codegraph'))).toBe(false);
    expect(isCodeGraphIndexed(repo)).toBe(false);
  });

  it('end-to-end: a genuinely corrupted repo gets correctly re-indexed by a real codegraph init call', () => {
    if (!(() => { try { execSync('command -v codegraph', { stdio: 'ignore' }); return true; } catch { return false; } })()) {
      return; // codegraph binary not on PATH in this environment — skip, matches other tests' guard style
    }
    const repo = makeRepoDir();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
    const cgDir = join(repo, '.codegraph');
    mkdirSync(cgDir, { recursive: true });
    // Simulate the exact live-found corrupt state before re-indexing.
    writeFileSync(join(cgDir, '.gitignore'), 'codegraph.db\n');
    expect(isCodeGraphIndexed(repo)).toBe(false);

    execSync(`codegraph init "${repo}"`, { stdio: 'ignore' });
    expect(isCodeGraphIndexed(repo)).toBe(true);
  }, 30000);
});
