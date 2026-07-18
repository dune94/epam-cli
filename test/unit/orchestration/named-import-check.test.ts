/**
 * Root cause of a live defect (found 2026-07-07): SKY-002-test-1 burned its
 * ENTIRE ladder escalation (8 attempts, ending on the strongest configured
 * model, $0.25) on `import { SkyScannerClient } from './client'` when the
 * real export is `SkyscannerClient` (one-character casing difference) — and
 * never converged because the failure-analyst MISDIAGNOSED it as a
 * default-vs-named export mismatch. It wasn't; the class IS correctly a
 * named export, just spelled differently. Every retry, including the
 * strongest model, "fixed" the wrong thing because the diagnosis guiding it
 * was wrong — a stronger model can't fix a bug it's been told doesn't exist.
 *
 * run_named_import_check() closes this gap deterministically: no model
 * judgment involved, no hardcoded class/identifier names — parses exports
 * via regex (same generic approach as run_relative_import_check) and checks
 * each named import identifier actually exists in its target's export set,
 * suggesting the case-insensitive match when exactly one exists.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

describe('run_named_import_check — design (static)', () => {
  const body = extractFunctionByLineAnchor('run_named_import_check');

  it('is wired before the test command runs (fail-fast, same as relative-import-check)', () => {
    const checkIdx = claudeSrc.indexOf('run_named_import_check "$PROJECT_ROOT"');
    const testCmdIdx = claudeSrc.indexOf('Running external verification: $test_cmd');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(testCmdIdx);
  });

  it('sets VERIFICATION_FAILURE so the existing failure-analyst/retry-prompt channel picks it up', () => {
    expect(body).toMatch(/VERIFICATION_FAILURE=\$\(printf/);
  });

  it('auto-fix is opt-in (EPAM_AUTO_FIX_NAMED_IMPORTS), off by default', () => {
    expect(body).toMatch(/auto_fix="\$\{EPAM_AUTO_FIX_NAMED_IMPORTS:-false\}"/);
  });

  it('auto-fix only fires on an UNAMBIGUOUS case-insensitive match (exactly one candidate)', () => {
    expect(body).toMatch(/len\(case_matches\) == 1/);
  });

  it('auto-fix is scoped to files the current story owns', () => {
    expect(body).toMatch(/os\.path\.normpath\(fpath\) in owned_files/);
  });

  it('the actual matching logic is a generic regex/set operation, not a literal identifier comparison', () => {
    // Comments may (and do) reference the motivating live bug by name for
    // documentation purposes — same convention already used by
    // run_relative_import_check. What must never happen is the CHECK ITSELF
    // comparing against a literal class/identifier string.
    expect(body).toMatch(/imported_name in exports/);
    expect(body).toMatch(/e\.lower\(\) == imported_name\.lower\(\)/);
  });
});

describe('run_named_import_check — REAL execution against the exact live defect', () => {
  function runCheck(opts: {
    files: Record<string, string>;
    ownedFiles?: string[];
    autoFix?: boolean;
  }): { rc: number; output: string; fileContents: Record<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), 'named-import-test-'));
    try {
      for (const [relPath, content] of Object.entries(opts.files)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          stories: [
            {
              id: 'SKY-999',
              technicalNotes: { files: (opts.ownedFiles ?? []).map((f) => join(dir, f)) },
            },
          ],
        }),
      );
      const fnBody = extractFunctionByLineAnchor('run_named_import_check');
      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(
        scriptPath,
        [
          `VERIFICATION_FAILURE=""`,
          `log() { echo "$1"; }`,
          `warning() { echo "$1"; }`,
          `PRD_FILE="${prdFile}"`,
          opts.autoFix ? `EPAM_AUTO_FIX_NAMED_IMPORTS="true"` : '',
          fnBody,
          `run_named_import_check "${dir}" "${outLog}" "SKY-999"`,
          `echo "RC=$?"`,
          `cat "${outLog}" 2>/dev/null || true`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      const fileContents: Record<string, string> = {};
      for (const relPath of Object.keys(opts.files)) {
        fileContents[relPath] = readFileSync(join(dir, relPath), 'utf8');
      }
      return { rc, output, fileContents };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect: casing typo detected with the correct suggestion', () => {
    const { rc, output } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {\n  constructor() {}\n}',
        'src/skyscanner/client.test.ts': "import { SkyScannerClient } from './client';\nconst c = new SkyScannerClient();",
      },
      ownedFiles: ['src/skyscanner/client.test.ts'],
    });
    expect(rc).toBe(1);
    expect(output).toContain("imports 'SkyScannerClient' from './client' which is not exported there");
    expect(output).toContain("Did you mean 'SkyscannerClient'?");
  });

  it('passes cleanly when the imported name matches a real export exactly', () => {
    const { rc } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner/client';",
      },
    });
    expect(rc).toBe(0);
  });

  it('passes cleanly when there are no named imports at all (default/namespace imports untouched)', () => {
    const { rc } = runCheck({
      files: {
        'src/util.ts': 'export default function helper() {}',
        'src/index.ts': "import helper from './util';",
      },
    });
    expect(rc).toBe(0);
  });

  it('ignores a broken FILE PATH — that is run_relative_import_check\'s job, not this one', () => {
    const { rc } = runCheck({
      files: {
        'src/index.ts': "import { X } from './totally-nonexistent-module';",
      },
    });
    expect(rc).toBe(0);
  });

  it('does not false-positive when NO export matches even case-insensitively (no suggestion, but still flagged)', () => {
    const { rc, output } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { TotallyDifferentName } from './skyscanner/client';",
      },
      ownedFiles: ['src/cli.ts'],
    });
    expect(rc).toBe(1);
    expect(output).toContain("imports 'TotallyDifferentName'");
    expect(output).not.toContain('Did you mean');
  });

  it('handles an "as" rename alias — checks the ORIGINAL exported name, not the local alias', () => {
    const { rc } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient as Client } from './skyscanner/client';",
      },
    });
    expect(rc).toBe(0);
  });

  it('recognizes an export list re-export (export { A as B })', () => {
    const { rc } = runCheck({
      files: {
        'src/skyscanner/internal.ts': 'class Impl {}\nexport { Impl as SkyscannerClient };',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner/internal';",
      },
    });
    expect(rc).toBe(0);
  });

  it('auto-fix disabled (default): does not rewrite the file, still reports broken', () => {
    const { rc, fileContents } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyScannerClient } from './skyscanner/client';\nnew SkyScannerClient();",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: false,
    });
    expect(rc).toBe(1);
    expect(fileContents['src/cli.ts']).toContain('SkyScannerClient');
  });

  it('auto-fix enabled + owned file: rewrites BOTH the import AND usage sites (the exact bug my own first attempt at this fix had)', () => {
    const { rc, output, fileContents } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyScannerClient } from './skyscanner/client';\nconst c = new SkyScannerClient();",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: true,
    });
    expect(rc).toBe(0);
    expect(fileContents['src/cli.ts']).toBe(
      "import { SkyscannerClient } from './skyscanner/client';\nconst c = new SkyscannerClient();",
    );
    expect(output).toContain("[named-import-check] Auto-corrected src/cli.ts: 'SkyScannerClient' -> 'SkyscannerClient'");
  });

  it('REPRODUCES a SECOND live defect and proves the fix: a broken import in a file NOT owned by this story does not rewrite AND no longer blocks this story', () => {
    // Root cause this fixes (found live, 2026-07-09/10, tier3-travel-app
    // run): a pre-existing broken import in cli.ts (owned by an already-
    // completed, DIFFERENT story) permanently blocked SKY-002-test — which
    // owned only client.test.ts and was scope-guarded from ever touching
    // cli.ts — exhausting all 8 retries on a bug it was structurally
    // incapable of fixing. Blocking (not just auto-fix eligibility) is now
    // scoped to files the CURRENT story actually owns.
    const { rc, output, fileContents } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyScannerClient } from './skyscanner/client';",
      },
      ownedFiles: ['src/some-other-file.ts'],
      autoFix: true,
    });
    expect(rc).toBe(0);
    expect(fileContents['src/cli.ts']).toContain('SkyScannerClient');
    expect(output).toContain('Broken import outside this story\'s scope (not blocking)');
    expect(output).toContain("src/cli.ts: imports 'SkyScannerClient'");
  });

  it('a broken import in an OWNED file still blocks (auto-fix off) — no regression from the scoping fix', () => {
    const { rc, fileContents } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyScannerClient } from './skyscanner/client';",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: false,
    });
    expect(rc).toBe(1);
    expect(fileContents['src/cli.ts']).toContain('SkyScannerClient');
  });

  it('auto-fix does not fire when the case-insensitive match is ambiguous (2+ candidates)', () => {
    const { rc, fileContents } = runCheck({
      files: {
        'src/dupe.ts': 'export class fooBar {}\nexport class FooBar {}\nexport class FOOBAR {}',
        'src/cli.ts': "import { Foobar } from './dupe';",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: true,
    });
    expect(rc).toBe(1);
    expect(fileContents['src/cli.ts']).toContain('Foobar');
  });

  it('REPRODUCES SKY-003-b root cause: export async function is recognised as a valid export', () => {
    // `export async function main(...)` was invisible to EXPORT_DECL_RE before
    // the (?:async\s+)? addition — triggering a false positive that burned 2
    // orchestration blocks and a kimi-k3 escalation ($0.293) on run-20260717.
    const { rc } = runCheck({
      files: {
        'src/cli.ts': 'export async function main(args: string[]): Promise<void> { return; }',
        'src/cli.test.ts': "import { main } from './cli';\nawait main([]);",
      },
      ownedFiles: ['src/cli.test.ts'],
    });
    expect(rc).toBe(0);
  });

  it('export async function with wrong name still triggers the check', () => {
    const { rc, output } = runCheck({
      files: {
        'src/cli.ts': 'export async function main(): Promise<void> {}',
        'src/cli.test.ts': "import { Main } from './cli';",
      },
      ownedFiles: ['src/cli.test.ts'],
    });
    expect(rc).toBe(1);
    expect(output).toContain("Did you mean 'main'?");
  });
});
