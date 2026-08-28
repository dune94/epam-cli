/**
 * post-impl-tc-writer.sh — deterministic repair of invalid JSON escape
 * sequences in the agent's TC output, REAL execution tests.
 *
 * Root cause this fixes (found live, 2026-07-09, tier3-travel-app run): this
 * PRD is full of regex-based validation ACs (date format, IATA codes, CLI
 * flag parsing, etc.), so the TC writer agent is routinely asked to describe
 * a validation regex verbatim as a "fact" — e.g. "regex /^\d{4}-\d{2}-\d{2}$/".
 * It wrote the literal backslash from \d straight into the JSON string
 * without escaping it to \\d. \d is not a valid JSON escape sequence, so
 * json.load hard-failed with "Invalid \escape: line 15 column 37", which
 * hard-aborted the ENTIRE phase even though every other fact in the file
 * (including the story's own facts) was fine — an LLM formatting slip
 * (not a story-implementation problem) blocked the whole pipeline.
 *
 * This is a narrow, mechanical defect class (a lone backslash not forming
 * one of JSON's actual escape sequences: \" \\ \/ \b \f \n \r \t \uXXXX) —
 * deterministically repairable by escaping any such backslash and retrying
 * the parse once before giving up.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const LOGS_DIR = join(REPO_ROOT, 'orchestrations/logs');

describe('post-impl-tc-writer.sh — invalid-escape repair (static)', () => {
  const src = readFileSync(TC_WRITER_SH, 'utf8');

  it('reads the raw TC file text before attempting to parse it', () => {
    expect(src).toMatch(/tc_raw = f\.read\(\)/);
  });

  it('attempts a deterministic repair on JSONDecodeError before giving up', () => {
    const idx = src.indexOf('except json.JSONDecodeError as e:');
    const block = src.slice(idx, idx + 3200);
    expect(block).toMatch(/repaired = re\.sub/);
    expect(block).toMatch(/tc_data = json\.loads\(repaired\)/);
  });

  it('still fails (does not mask a genuinely different JSON error) if the repair attempt also fails to parse', () => {
    const idx = src.indexOf('except json.JSONDecodeError as e:');
    const block = src.slice(idx, idx + 3200);
    expect(block).toMatch(/repair attempt also failed/);
    expect(block).toMatch(/sys\.exit\(1\)/);
  });

  it('builds the regex pattern via chr(92), not a literal backslash (this code sits inside an UNQUOTED bash heredoc)', () => {
    const idx = src.indexOf('_bs = chr(92)');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    // A literal backslash character here would be silently collapsed by the
    // unquoted heredoc before Python ever sees it (confirmed live: `\\` in
    // this bash file becomes a single `\` in the executed Python).
    expect(block).not.toMatch(/'\\\\/);
  });
});

describe('post-impl-tc-writer.sh — REAL execution, invalid-escape repair', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      rmSync(p, { force: true });
    }
  });

  function uniquePhase(label: string): string {
    return `test-escaperepair-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function setup(phase: string, tcFileRawContent: string) {
    const dir = mkdtempSync(join(tmpdir(), 'tc-writer-escape-repair-'));
    const prdPath = join(dir, 'prd.json');
    const prd = {
      implementationOrder: { [phase]: ['SKY-003-test'] },
      stories: [
        {
          id: 'SKY-003-test',
          status: 'pending',
          technicalNotes: { files: ['src/cli.test.ts'] },
        },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd));

    const tcOutFile = join(LOGS_DIR, `tc-${phase}.json`);
    const tcLogFile = join(LOGS_DIR, `tc-writer-${phase}.log`);
    cleanupPaths.push(tcOutFile, tcLogFile);

    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stubPath = join(binDir, 'epam-stub.sh');
    writeFileSync(
      stubPath,
      [
        '#!/usr/bin/env bash',
        `mkdir -p "${LOGS_DIR}"`,
        `cat > "${tcOutFile}" << 'STUBEOF'`,
        tcFileRawContent,
        'STUBEOF',
        'echo TC_WRITER_DONE',
        'exit 0',
      ].join('\n')
    );
    chmodSync(stubPath, 0o755);

    return { dir, prdPath, stubPath };
  }

  it('REPRODUCES the exact live bug: an unescaped \\d regex in a TC fact hard-fails json.load', () => {
    const phase = uniquePhase('bug');
    // Raw file content is NOT run through JSON.stringify — it's exactly the
    // malformed bytes a real agent wrote: a literal, unescaped \d.
    const malformed = '{"SKY-003-test":{"verifiedAt":"2026-01-01T00:00:00Z","sourceFiles":["src/cli.ts"],"facts":["Date validation uses regex /^\\d{4}-\\d{2}-\\d{2}$/ and checks parsed Date is valid"],"mockStrategy":"vi.mock(...)","bannedPatterns":[]}}';
    const { dir, prdPath, stubPath } = setup(phase, malformed);

    let exitCode = -1;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [
        TC_WRITER_SH, '--prd', prdPath, '--phase', phase, '--output-dir', dir,
      ], { encoding: 'utf8', env: { ...process.env, EPAM_BIN: stubPath } });
      exitCode = 0;
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      exitCode = e.status ?? -1;
    }

    // The repair should succeed, not just detect the bug — this is the FIX,
    // not a bug-reproduction-only test (the malformed content used here is
    // byte-for-byte the pattern seen live).
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/auto-repaired by escaping stray backslashes/);
    expect(stdout).toMatch(/Gate PASSED/);

    const updatedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const facts = updatedPrd.stories[0].testCriteria?.facts ?? [];
    expect(facts[0]).toBe('Date validation uses regex /^\\d{4}-\\d{2}-\\d{2}$/ and checks parsed Date is valid');
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves the regex content correctly after repair (does not mangle \\d into something else)', () => {
    const phase = uniquePhase('preserve');
    const malformed = '{"SKY-003-test":{"verifiedAt":"2026-01-01T00:00:00Z","sourceFiles":["src/cli.ts"],"facts":["IATA code regex is /^[A-Z]\\d?{3}$/ per spec"],"mockStrategy":"none","bannedPatterns":[]}}';
    const { dir, prdPath, stubPath } = setup(phase, malformed);

    execFileSync('bash', [
      TC_WRITER_SH, '--prd', prdPath, '--phase', phase, '--output-dir', dir,
    ], { encoding: 'utf8', env: { ...process.env, EPAM_BIN: stubPath } });

    const updatedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const fact = updatedPrd.stories[0].testCriteria.facts[0];
    expect(fact).toBe('IATA code regex is /^[A-Z]\\d?{3}$/ per spec');
    rmSync(dir, { recursive: true, force: true });
  });

  it('REPRODUCES a SECOND live defect and proves the fix: an already-valid "\\\\" (escaped-backslash) pair sitting next to a genuinely dangling backslash is not corrupted by the repair', () => {
    // Root cause (found live, 2026-07-09, same run): the original repair
    // matched each backslash independently, so it treated the SECOND
    // backslash of an already-valid "\\" pair (e.g. \\s, \\-, \\d in a regex
    // fact) as if it were a fresh dangling backslash needing escaping —
    // silently corrupting \s (whitespace) into \\s (literal backslash-s) in
    // the decoded string. Fixed by matching whole backslash RUNS and only
    // padding a run when its length is odd. This fixture combines BOTH
    // defect shapes in one file, exactly as the live tc-core.json did: a
    // dangling single backslash before a backtick (invalid, needs repair)
    // AND an already-valid "\\s\\-" pair (must survive untouched).
    const phase = uniquePhase('mixed');
    const malformed = '{"SKY-003-test":{"verifiedAt":"2026-01-01T00:00:00Z","sourceFiles":["src/cli.ts"],"facts":["URL built as new URL(\\`${base}/search\\`)","origin regex /^[A-Za-z0-9\\\\s\\\\-]{1,50}$/ validates input"],"mockStrategy":"vi.mock(...)","bannedPatterns":[]}}';
    const { dir, prdPath, stubPath } = setup(phase, malformed);

    const stdout = execFileSync('bash', [
      TC_WRITER_SH, '--prd', prdPath, '--phase', phase, '--output-dir', dir,
    ], { encoding: 'utf8', env: { ...process.env, EPAM_BIN: stubPath } });

    expect(stdout).toMatch(/auto-repaired by escaping stray backslashes/);
    expect(stdout).toMatch(/Gate PASSED/);

    const updatedPrd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const facts: string[] = updatedPrd.stories[0].testCriteria.facts;
    expect(facts[0]).toBe('URL built as new URL(\\`${base}/search\\`)');
    // The already-valid pair must decode to a SINGLE backslash before s/-,
    // not a double one — this is the exact corruption the old regex caused.
    expect(facts[1]).toBe('origin regex /^[A-Za-z0-9\\s\\-]{1,50}$/ validates input');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT mask a genuinely different (non-escape) JSON syntax error', () => {
    const phase = uniquePhase('genuinelybroken');
    // Missing closing brace — not an escape problem at all.
    const brokenJson = '{"SKY-003-test":{"verifiedAt":"2026-01-01T00:00:00Z","facts":["ok"]';
    const { dir, prdPath, stubPath } = setup(phase, brokenJson);

    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [
        TC_WRITER_SH, '--prd', prdPath, '--phase', phase, '--output-dir', dir,
      ], { encoding: 'utf8', env: { ...process.env, EPAM_BIN: stubPath } });
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      exitCode = e.status ?? -1;
    }

    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/repair attempt also failed/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a well-formed TC file (already-valid JSON) is unaffected — no spurious repair message', () => {
    const phase = uniquePhase('clean');
    const valid = JSON.stringify({
      'SKY-003-test': {
        verifiedAt: '2026-01-01T00:00:00Z',
        sourceFiles: ['src/cli.ts'],
        facts: ['clean fact, no backslashes'],
        mockStrategy: 'none',
        bannedPatterns: [],
      },
    });
    const { dir, prdPath, stubPath } = setup(phase, valid);

    const stdout = execFileSync('bash', [
      TC_WRITER_SH, '--prd', prdPath, '--phase', phase, '--output-dir', dir,
    ], { encoding: 'utf8', env: { ...process.env, EPAM_BIN: stubPath } });

    expect(stdout).not.toMatch(/auto-repaired/);
    expect(stdout).toMatch(/Gate PASSED/);
    rmSync(dir, { recursive: true, force: true });
  });
});
