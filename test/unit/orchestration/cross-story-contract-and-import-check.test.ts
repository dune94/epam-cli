/**
 * Options A + D — built after Option E (live-model validation, see
 * test/integration/contract-sharing-validation.test.ts) confirmed the root
 * cause: an agent guessing a sibling module's import path (because worktree
 * isolation means it can't see the producing story's actual file layout)
 * reliably guesses wrong ('./skyscanner-client') without contract info, and
 * reliably guesses right ('./skyscanner/client') when the contract is given.
 *
 * A — build_implementation_prompt() now reads the story's dependency
 *     stories' contract files (.contracts/<dep-id>.md, already written by
 *     the typescript-engineer profile's existing "CONTRACT SCRATCHPAD" step)
 *     and injects them directly into the prompt — guaranteed inclusion, not
 *     dependent on the agent choosing to read the file itself.
 *
 * D — run_relative_import_check() deterministically detects a relative
 *     import that doesn't resolve to a real file, BEFORE running the (often
 *     multi-minute) test command, and suggests the likely correct path via
 *     filename-token overlap. Complements A as a safety net for when the
 *     contract wasn't available or was ignored.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

// ── Option A: contract injection (static checks) ────────────────────────────

describe('Option A — build_implementation_prompt() injects dependency contracts', () => {
  const body = extractFunctionBody('build_implementation_prompt');

  it('reads each dependency ID from .dependencies / technicalNotes.dependsOn', () => {
    expect(body).toMatch(/\.dependencies \/\/ \.technicalNotes\.dependsOn/);
  });

  it('looks for a contract file at $PROJECT_ROOT/.contracts/<dep-id>.md', () => {
    expect(body).toMatch(/\$PROJECT_ROOT\/\.contracts\/\$\{_dep_id\}\.md/);
  });

  it('only includes a contract when the file actually exists (no fabricated content)', () => {
    expect(body).toMatch(/if \[ -f "\$_contract_file" \]/);
  });

  it('the final prompt template includes the dependency_contracts section, labeled to discourage guessing', () => {
    const idx = claudeSrc.indexOf('Dependency Contracts');
    expect(idx).toBeGreaterThan(-1);
    const line = claudeSrc.slice(claudeSrc.lastIndexOf('\n', idx), claudeSrc.indexOf('\n', idx));
    expect(line).toMatch(/do NOT guess a different path/i);
  });
});

// ── Option D: relative import check (static + real execution) ───────────────

describe('Option D — run_relative_import_check() design', () => {
  const body = extractFunctionBody('run_relative_import_check');

  it('auto-rewrite is opt-in (EPAM_AUTO_FIX_RELATIVE_IMPORTS), not the default behavior', () => {
    // Detect-and-suggest remains the default; auto-apply only activates when
    // explicitly enabled (2026-07-07 — added after a live run showed the SAME
    // violation surviving 3 full ladder escalations, since it's a mechanical
    // habit, not a reasoning-capability gap that a stronger model fixes).
    expect(body).toMatch(/auto_fix="\$\{EPAM_AUTO_FIX_RELATIVE_IMPORTS:-false\}"/);
  });

  it('auto-fix requires high confidence (score >= 2) — stricter than the >0 threshold used for merely suggesting', () => {
    expect(body).toMatch(/best_score >= 2/);
  });

  it('auto-fix is scoped to files the current story owns — never rewrites a file outside this attempt\'s scope', () => {
    expect(body).toMatch(/os\.path\.normpath\(fpath\) in owned_files/);
    expect(body).toMatch(/technicalNotes\.files/);
  });

  it('is wired before the test command runs, and skips the test run entirely on a broken import', () => {
    const checkIdx = claudeSrc.indexOf('run_relative_import_check "$PROJECT_ROOT"');
    const testCmdIdx = claudeSrc.indexOf('Running external verification: $test_cmd');
    const returnIdx = claudeSrc.indexOf('return 1', checkIdx);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(checkIdx);
    expect(returnIdx).toBeLessThan(testCmdIdx);
  });

  it('sets VERIFICATION_FAILURE so the existing failure-analyst/retry-prompt channel picks it up (no new plumbing needed)', () => {
    expect(body).toMatch(/VERIFICATION_FAILURE=\$\(printf/);
  });
});

describe('run_relative_import_check — REAL execution against the exact live defect', () => {
  function runCheck(files: Record<string, string>): { rc: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'rel-import-test-'));
    try {
      for (const [relPath, content] of Object.entries(files)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const fnBody = extractFunctionBody('run_relative_import_check');
      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(
        scriptPath,
        `VERIFICATION_FAILURE=""\n${fnBody}\nrun_relative_import_check "${dir}" "${outLog}"\necho "RC=$?"\necho "VF=$VERIFICATION_FAILURE"\n`
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      return { rc, output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and suggests the exact correct path', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client';",
    });
    expect(rc).toBe(1);
    expect(output).toContain("imports './skyscanner-client' which does not exist");
    expect(output).toContain("Did you mean './skyscanner/client'?");
  });

  it('passes cleanly when the import is already correct', () => {
    const { rc } = runCheck({
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/cli.ts': "import { SkyscannerClient } from './skyscanner/client';",
    });
    expect(rc).toBe(0);
  });

  it('passes cleanly when there are no relative imports at all', () => {
    const { rc } = runCheck({
      'src/index.ts': "import express from 'express';",
    });
    expect(rc).toBe(0);
  });

  it('resolves imports missing their file extension against a real file', () => {
    const { rc } = runCheck({
      'src/util.ts': 'export const x = 1;',
      'src/index.ts': "import { x } from './util';",
    });
    expect(rc).toBe(0);
  });

  it('resolves a directory import via its index file', () => {
    const { rc } = runCheck({
      'src/lib/index.ts': 'export const y = 1;',
      'src/index.ts': "import { y } from './lib';",
    });
    expect(rc).toBe(0);
  });

  it('does not false-positive when no correct-path candidate exists (no suggestion, but still flagged)', () => {
    const { rc, output } = runCheck({
      'src/index.ts': "import { z } from './totally-nonexistent-module';",
    });
    expect(rc).toBe(1);
    expect(output).toContain("imports './totally-nonexistent-module' which does not exist");
    expect(output).not.toContain('Did you mean');
  });

  it('never suggests a .test/.spec sibling as the fix — an implementation file and its test file tie on token overlap, but only the implementation file is a valid import target', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/skyscanner/client.test.ts': "import { SkyscannerClient } from './client';",
      'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
    });
    expect(rc).toBe(1);
    expect(output).toContain("Did you mean './skyscanner/client'?");
    expect(output).not.toContain('client.test');
  });
  // ── resolves() — TypeScript ESM .js→.ts remapping ────────────────────────
  // TypeScript with "moduleResolution": "node16"/"bundler" requires `.js`
  // extensions in import specifiers even though the file on disk is `.ts`.
  // The checker must NOT flag these as broken (they'd have caused an infinite
  // escalation loop where the agent produced correct ESM imports but the
  // checker kept reporting them as unresolved — live bug 2026-07-17).

  it('resolves a .js import whose corresponding .ts file exists (TypeScript ESM pattern)', () => {
    const { rc } = runCheck({
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/cli.ts': "import { SkyscannerClient } from './skyscanner/client.js';",
    });
    expect(rc).toBe(0);
  });

  it('resolves a .js import whose corresponding .tsx file exists', () => {
    const { rc } = runCheck({
      'src/components/Button.tsx': 'export const Button = () => null;',
      'src/App.ts': "import { Button } from './components/Button.js';",
    });
    expect(rc).toBe(0);
  });

  it('still flags a .js import when neither .js nor .ts nor .tsx file exists at that path', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/cli.ts': "import { SkyscannerClient } from './nonexistent.js';",
    });
    expect(rc).toBe(1);
    expect(output).toContain("imports './nonexistent.js' which does not exist");
  });

  it('still flags a wrong-directory .js import even when a .ts file exists elsewhere', () => {
    // ./skyscanner-client.js is wrong dir — no skyscanner-client.ts exists at src/
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
    });
    expect(rc).toBe(1);
    expect(output).toContain("Did you mean './skyscanner/client'?");
  });

  it('resolves a .js import for a nested path (not just top-level)', () => {
    const { rc } = runCheck({
      'src/utils/format.ts': 'export const fmt = (s: string) => s;',
      'src/index.ts': "import { fmt } from './utils/format.js';",
    });
    expect(rc).toBe(0);
  });

  it('resolves a .js import to an actual .js file on disk (not just remapped .ts)', () => {
    const { rc } = runCheck({
      'src/legacy.js': 'module.exports = {};',
      'src/index.ts': "import legacy from './legacy.js';",
    });
    expect(rc).toBe(0);
  });
});

/**
 * Auto-fix (2026-07-07): the SAME broken-import class recurring across a
 * story's ENTIRE ladder escalation (base model through the strongest
 * configured model, 3 full HealingBroken rung-skips) proved this is a
 * mechanical habit (redundant .js extension in a CommonJS project), not a
 * reasoning-capability gap a stronger model fixes. When enabled, the check
 * now mechanically corrects HIGH-confidence matches instead of only hinting.
 */
describe('run_relative_import_check — auto-fix (REAL execution)', () => {
  function runCheckWithAutoFix(opts: {
    files: Record<string, string>;
    ownedFiles: string[];
    autoFix?: boolean;
  }): { rc: number; output: string; fileContents: Record<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), 'rel-import-autofix-test-'));
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
              technicalNotes: { files: opts.ownedFiles.map((f) => join(dir, f)) },
            },
          ],
        }),
      );
      const fnBody = extractFunctionBody('run_relative_import_check');
      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(
        scriptPath,
        [
          `VERIFICATION_FAILURE=""`,
          `PRD_FILE="${prdFile}"`,
          `log() { echo "$1"; }`,
          opts.autoFix ? `EPAM_AUTO_FIX_RELATIVE_IMPORTS="true"` : '',
          fnBody,
          `run_relative_import_check "${dir}" "${outLog}" "SKY-999"`,
          `echo "RC=$?"`,
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

  it('opt-in disabled (default): does NOT rewrite the file, still reports broken', () => {
    // ./skyscanner-client.js is wrong directory — no skyscanner-client.ts at src/ root
    const { rc, fileContents } = runCheckWithAutoFix({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: false,
    });
    expect(rc).toBe(1);
    expect(fileContents['src/cli.ts']).toContain("'./skyscanner-client.js'");
  });

  it('opt-in enabled + high confidence + owned file: rewrites the import in place and reports success', () => {
    const { rc, output, fileContents } = runCheckWithAutoFix({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: true,
    });
    expect(rc).toBe(0);
    expect(fileContents['src/cli.ts']).toContain("'./skyscanner/client'");
    expect(fileContents['src/cli.ts']).not.toContain('skyscanner-client.js');
    expect(output).toContain("[relative-import-check] Auto-corrected src/cli.ts: './skyscanner-client.js' -> './skyscanner/client'");
  });

  it('opt-in enabled but the importing file is NOT in the story\'s owned files: does NOT rewrite, stays flagged', () => {
    const { rc, fileContents } = runCheckWithAutoFix({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      },
      ownedFiles: ['src/some-other-file.ts'], // cli.ts NOT owned by this story
      autoFix: true,
    });
    expect(rc).toBe(1);
    expect(fileContents['src/cli.ts']).toContain('skyscanner-client.js');
  });

  it('opt-in enabled but confidence too low (score < 2, ambiguous single-token match): does NOT rewrite, stays flagged', () => {
    // 'utils' alone (one token) ties against many candidates in a real project;
    // the auto-fix threshold requires score >= 2 specifically to avoid acting
    // on this kind of weak, easily-ambiguous match.
    const { rc, fileContents } = runCheckWithAutoFix({
      files: {
        'src/utils.ts': 'export const x = 1;',
        'src/cli.ts': "import { x } from './utils-helper';",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: true,
    });
    expect(rc).toBe(1);
    expect(fileContents['src/cli.ts']).toContain('./utils-helper');
  });

  it('preserves the original quote style (single quotes) when rewriting', () => {
    const { fileContents } = runCheckWithAutoFix({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      },
      ownedFiles: ['src/cli.ts'],
      autoFix: true,
    });
    expect(fileContents['src/cli.ts']).toMatch(/from '\.\/skyscanner\/client'/);
  });
});

// ── Spec-reality cross-check (2026-07-06): the PRD's own description/ACs can
// themselves be wrong (an LLM-authored/elaborated artifact, just as
// hallucination-prone as agent-generated code) — this is a DIFFERENT bug
// class from Option D above (a model guessing wrong): here the model is
// TOLD a wrong path in its own task description and faithfully follows it.
// Live root cause: SKY-003's canonical description said "Instantiate
// SkyscannerClient from `src/skyscanner-client.ts`" when the real file
// SKY-002 built was at `src/skyscanner/client.ts`.

describe('build_implementation_prompt() — spec-reality cross-check (static)', () => {
  const body = extractFunctionBody('build_implementation_prompt');

  it('extracts backtick-quoted path-like strings from the story\'s own description/ACs', () => {
    expect(body).toMatch(/PATH_RE = re\.compile/);
  });

  it('compares claimed paths against the REAL dependency technicalNotes.files (ground truth), not model-transcribed content', () => {
    expect(body).toMatch(/technicalNotes\.files\[\]/);
  });

  it('injects the mismatch warning at the TOP of the prompt (primacy), not buried mid-prompt', () => {
    // Primacy is determined by the order of REFERENCES inside the `cat << EOF`
    // template that assembles the prompt — NOT by where literal strings are
    // defined in the function. The write-first directive text now lives in the
    // $write_first_directive variable (assigned above the template, so it can
    // branch on brownfield/greenfield), so follow the reference, not the literal.
    const templateStart = body.indexOf('cat << EOF');
    expect(templateStart).toBeGreaterThan(-1);
    const template = body.slice(templateStart);
    const warningRefIdx = template.indexOf('$spec_reality_warning');
    const directiveRefIdx = template.indexOf('$write_first_directive');
    expect(warningRefIdx).toBeGreaterThan(-1);
    expect(directiveRefIdx).toBeGreaterThan(-1);
    expect(warningRefIdx).toBeLessThan(directiveRefIdx);
  });

  it('is detection-only — does not silently rewrite the PRD/description (Option D pattern: flag, don\'t auto-fix)', () => {
    const pyStart = body.indexOf("<< 'PYEOF'", body.indexOf('spec_reality_warning'));
    const pyEnd = body.indexOf('\nPYEOF', pyStart);
    const pyBody = body.slice(pyStart, pyEnd);
    expect(pyBody).not.toMatch(/open\([^)]*['"]w['"]\)/);
  });
});

describe('build_implementation_prompt() — spec-reality cross-check REAL execution', () => {
  function runPrompt(storyJson: Record<string, unknown>, prdStories: Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'spec-reality-test-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: prdStories }));

      const fnBody = extractFunctionBody('build_implementation_prompt');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdPath}"`,
          `PROJECT_ROOT="${dir}"`,
          `GIT_WORK_ROOT="${dir}"`,
          `get_story_details() { echo '${JSON.stringify(storyJson).replace(/'/g, "'\\''")}'; }`,
          fnBody,
          `build_implementation_prompt "${storyJson.id}"`,
        ].join('\n'),
      );
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live SKY-003 defect: flags a wrong path in the description against the dependency\'s real file', () => {
    const output = runPrompt(
      {
        id: 'SKY-003',
        title: 'CLI',
        description: 'Instantiate SkyscannerClient from `src/skyscanner-client.ts` and call searchFlights.',
        acceptanceCriteria: ['CLI works'],
        technicalNotes: { files: ['/tmp/x/src/cli.ts'] },
        dependencies: ['SKY-002'],
      },
      [
        { id: 'SKY-002', technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] } },
      ],
    );
    expect(output).toContain('SPEC-REALITY MISMATCH');
    expect(output).toContain('src/skyscanner-client.ts');
    expect(output).toContain('src/skyscanner/client.ts');
    expect(output).toContain('TRUST THE CONTRACT SECTION BELOW');
  });

  it('does NOT flag anything when the description already matches reality', () => {
    const output = runPrompt(
      {
        id: 'SKY-003',
        title: 'CLI',
        description: 'Instantiate SkyscannerClient from `src/skyscanner/client.ts` and call searchFlights.',
        acceptanceCriteria: ['CLI works'],
        technicalNotes: { files: ['/tmp/x/src/cli.ts'] },
        dependencies: ['SKY-002'],
      },
      [
        { id: 'SKY-002', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      ],
    );
    expect(output).not.toContain('SPEC-REALITY MISMATCH');
  });

  it('does NOT flag anything when the story has no dependencies (nothing to cross-check against)', () => {
    const output = runPrompt(
      {
        id: 'SKY-001',
        title: 'Scaffold',
        description: 'Set up the project.',
        acceptanceCriteria: ['package.json exists'],
        technicalNotes: { files: ['/tmp/x/package.json'] },
        dependencies: [],
      },
      [],
    );
    expect(output).not.toContain('SPEC-REALITY MISMATCH');
  });

  it('is domain-agnostic — proves this with a non-travel-app example (e-commerce Cart)', () => {
    const output = runPrompt(
      {
        id: 'ORDER-002',
        title: 'Checkout',
        description: 'Instantiate Cart from `src/cart-utils.ts` and call checkout().',
        acceptanceCriteria: ['Checkout works'],
        technicalNotes: { files: ['/tmp/x/src/checkout.ts'] },
        dependencies: ['ORDER-001'],
      },
      [
        { id: 'ORDER-001', technicalNotes: { files: ['src/cart/Cart.ts'] } },
      ],
    );
    expect(output).toContain('SPEC-REALITY MISMATCH');
    expect(output).toContain('src/cart-utils.ts');
    expect(output).toContain('src/cart/Cart.ts');
  });
});

// ── Exact String Invariant guardrail ─────────────────────────────────────────
// Root cause this fixes (found live, 2026-07-06): SKY-002-impl failed 8 times
// with 8 DIFFERENT bugs; several of those attempts got a quoted AC substring
// (an exact error-message string the test suite asserts on) slightly wrong —
// paraphrased, differently worded, or a fragment of it — because the model
// treated it as a summary rather than a literal invariant. This deterministically
// extracts every quoted string from the ACs and tells the agent explicitly not
// to paraphrase them.
describe('build_implementation_prompt() — Exact String Invariant guardrail (static)', () => {
  const body = extractFunctionBody('build_implementation_prompt');

  it('extracts quoted substrings from acceptance_criteria via a deterministic regex (no LLM judgment)', () => {
    expect(body).toMatch(/grep -oE '"\[\^"\]\{3,\}"'/);
  });

  it('the injected block explicitly forbids paraphrasing and demands verbatim reproduction', () => {
    expect(body).toMatch(/STRING INVARIANTS/);
    expect(body).toMatch(/FORBIDDEN from paraphrasing/);
    expect(body).toMatch(/character-for-character/);
  });

  it('is generic — the executable logic (not motivating-example comments) hardcodes no travel-app/SKY-specific strings', () => {
    const idx = body.indexOf('STRING INVARIANTS');
    const block = body.slice(idx, idx + 400);
    expect(block).not.toMatch(/SKY-|apiKey|Skyscanner/);
  });
});

describe('build_implementation_prompt() — Exact String Invariant guardrail REAL execution', () => {
  function runPrompt(storyJson: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'string-invariant-test-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: [] }));

      const fnBody = extractFunctionBody('build_implementation_prompt');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdPath}"`,
          `PROJECT_ROOT="${dir}"`,
          `GIT_WORK_ROOT="${dir}"`,
          `get_story_details() { echo '${JSON.stringify(storyJson).replace(/'/g, "'\\''")}'; }`,
          fnBody,
          `build_implementation_prompt "${storyJson.id}"`,
        ].join('\n'),
      );
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live SKY-002-impl scenario: injects the literal error-message string as a verbatim invariant', () => {
    const output = runPrompt({
      id: 'SKY-002-impl',
      title: 'Client',
      description: 'Implement the Skyscanner client.',
      acceptanceCriteria: [
        'Constructor throws an Error whose message includes "via the constructor options.apiKey" when apiKey is missing',
      ],
      technicalNotes: { files: ['/tmp/x/src/client.ts'] },
      dependencies: [],
    });
    expect(output).toContain('STRING INVARIANTS');
    expect(output).toContain('"via the constructor options.apiKey"');
    expect(output).toMatch(/FORBIDDEN from paraphrasing/);
  });

  it('extracts MULTIPLE distinct quoted strings from different ACs, deduplicated', () => {
    const output = runPrompt({
      id: 'SKY-003',
      title: 'CLI',
      description: 'CLI tool.',
      acceptanceCriteria: [
        'Prints "No flights found." when results are empty',
        'Prints "No flights found." when results are empty', // duplicate AC, same string
        'Exits with message "RAPIDAPI_KEY environment variable is required"',
      ],
      technicalNotes: { files: ['/tmp/x/src/cli.ts'] },
      dependencies: [],
    });
    expect(output).toContain('"No flights found."');
    expect(output).toContain('"RAPIDAPI_KEY environment variable is required"');
    // deduplicated: "No flights found." should appear as a literal-strings list
    // entry exactly once, not twice, even though it came from two ACs.
    const occurrences = (output.match(/- "No flights found\."/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('does NOT inject the STRING INVARIANTS block when no AC contains a quoted string', () => {
    const output = runPrompt({
      id: 'SKY-001',
      title: 'Scaffold',
      description: 'Set up the project.',
      acceptanceCriteria: ['package.json exists', 'tsconfig.json is valid'],
      technicalNotes: { files: ['/tmp/x/package.json'] },
      dependencies: [],
    });
    expect(output).not.toContain('STRING INVARIANTS');
  });

  it('is domain-agnostic — proves this with a non-travel-app example (payment gateway)', () => {
    const output = runPrompt({
      id: 'CHECKOUT-004',
      title: 'Refund handler',
      description: 'Handle refunds.',
      acceptanceCriteria: [
        'Throws an error containing "refund amount exceeds original charge" when over-refunding',
      ],
      technicalNotes: { files: ['/tmp/x/src/refund.ts'] },
      dependencies: [],
    });
    expect(output).toContain('"refund amount exceeds original charge"');
  });
});
