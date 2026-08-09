/**
 * THE COMMIT-TIME SECRET SCAN BLOCKED CORRECT CODE AND CAUGHT NOTHING ELSE.
 *
 * Live 2026-08-09, AMSD-2041 on gotransit. The writer wired the Contentstack preview token the
 * way the scanner's own error message recommends — from an environment-derived constant:
 *
 *     management_token: CONTENTSTACK_LIVE_PREVIEW_TOKEN,
 *
 * The scan matched the SHAPE `credential_name: value` without looking at what `value` is, and
 * refused the commit: "possible credential(s) detected: generic credential-shaped assignment".
 * There is no credential in that line. The whole ticket is about wiring a preview token, so the
 * gate would have blocked every commit the story produces.
 *
 * Operator decision (2026-08-09): remove it from the commit path and let the review stage carry
 * the check instead, with a tool that can tell a literal from an identifier. The gate had never
 * caught a real leak, and a gate that only fires on correct work teaches everyone to route
 * around it.
 *
 * These tests fix the reason in place: the first two execute the scanner and demonstrate the
 * false positive, so nobody reinstates it believing it was sound. The last asserts the commit
 * path no longer consults it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCAN = join(__dirname, '../../../orchestrations/scripts/scan-secrets.sh');
const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A repo with the given line staged, exactly as Step 9 would present it. */
function repoWithStaged(line: string) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(join(dir, 'src', 'a.ts'), `export const x = 1;\n${line}\n`);
  git('add', '.');
  return dir;
}

/** Runs the real scanner; true = it refused. */
function refuses(line: string): boolean {
  const dir = repoWithStaged(line);
  const r = execFileSync('bash', ['-c', `bash ${JSON.stringify(SCAN)} ${JSON.stringify(dir)} >/dev/null 2>&1; echo $?`],
    { encoding: 'utf8' }).trim();
  return r !== '0';
}

describe('the scanner is real — it does detect a pasted literal', () => {
  it('a long quoted credential IS flagged', () => {
    // If this passed, the tests below would prove nothing about discrimination.
    expect(refuses('const apiKey = "blt9f2c4e7a1d8b3c6e5f0a9d2b4c7e1f8a";')).toBe(true);
  });
});

describe('THE DEFECT: it cannot tell a literal from an identifier', () => {
  it('the exact line from the live run is flagged, and contains no credential', () => {
    expect(
      refuses('  management_token: CONTENTSTACK_LIVE_PREVIEW_TOKEN,'),
      'an environment-derived identifier was reported as a credential, blocking the commit',
    ).toBe(true);
  });

  it('a process.env read is correctly NOT flagged — the scanner is not uniformly crude', () => {
    // Worth recording precisely: the defect is bare identifiers, not env access. I initially
    // asserted this was flagged too; it is not, and the scanner is better than that claim.
    expect(refuses('const token = process.env.CONTENTSTACK_LIVE_PREVIEW_TOKEN;')).toBe(false);
  });
});

describe('the commit path no longer consults it', () => {
  const src = readFileSync(ORCH, 'utf8');

  /**
   * The whole Step 9 block, bounded by the next step rather than a character count. A fixed
   * window silently excluded the invocation — it sat 1529 chars in against a 1400-char slice —
   * so the assertions passed while the gate was still wired. A mutation caught that.
   */
  function step9Block(): string {
    const from = src.indexOf('Step 9: Auto-committing');
    expect(from, 'the Step 9 block is gone from the orchestrator').toBeGreaterThan(-1);
    const next = src.indexOf('Step 10', from);
    const to = next > from ? next : from + 6000;
    const block = src.slice(from, to);
    expect(block.length, 'the block is suspiciously short — the bound is wrong').toBeGreaterThan(1600);
    return block;
  }

  it('Step 9 does not refuse a commit on a secret scan', () => {
    const step9 = step9Block();
    // Invocation, not mention: the block carries a comment explaining why the gate was
    // removed, and that comment names the script. Asserting on the name would forbid the
    // explanation along with the behaviour.
    expect(
      step9,
      'the commit is still gated on a scan that fires on correct code',
    ).not.toMatch(/bash\s+"\$SCRIPT_DIR\/scan-secrets\.sh"/);
    expect(step9, 'the commit is still refused on a scan verdict').not.toMatch(/Refusing to auto-commit/);
  });

  it('and does not silently unstage the writer\'s work', () => {
    // The live failure: the scan unstaged everything, `git add` then failed, and the story was
    // still reported "Implemented: 1, Failed: 0" with its work uncommitted.
    expect(step9Block()).not.toMatch(/reset 2>\/dev\/null/);
  });
});
