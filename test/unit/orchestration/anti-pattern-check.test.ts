/**
 * run_anti_pattern_check — deterministic, PROJECT-CONFIGURED detection of a
 * writer regressing to a documented-wrong pattern. No pattern is hardcoded
 * in the pipeline; rules come from <project>/anti-patterns.json.
 *
 * Built 2026-08-02 after a live Writer Retest run: two of three codelines
 * regressed to `management_token` instead of the prescribed `preview_token`
 * inside a Contentstack `live_preview` block — the EXACT defect a prior
 * team-lead review had already caught and the PRD explicitly warned against.
 * Relying on model compliance or a downstream LLM review to catch an
 * already-diagnosed wrong pattern is expensive and unreliable.
 *
 * Real temp files, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}
const FN_BODY = extractFunctionBody('run_anti_pattern_check');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANAGEMENT_TOKEN_RULES = JSON.stringify([
  {
    id: 'contentstack-live-preview-wrong-token-key',
    matchPattern: 'live_preview\\s*:\\s*\\{[^}]*management_token',
    message: 'Contentstack live_preview must use preview_token, not management_token.',
  },
]);

function runCheck(opts: {
  projectConfigDir: string | null;
  files: Record<string, string>;
  storyId?: string;
  ownedFiles?: string[];
}): { rc: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-'));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(opts.files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const prdPath = join(dir, 'prd.json');
  writeFileSync(
    prdPath,
    JSON.stringify({
      stories: [
        {
          id: opts.storyId ?? 'AMSD-2041',
          technicalNotes: { files: (opts.ownedFiles ?? Object.keys(opts.files)).map((f) => join(dir, f)) },
        },
      ],
    }),
  );
  const scriptPath = join(dir, 'run.sh');
  const outLog = join(dir, 'out.log');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      'VERIFICATION_FAILURE=""',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      opts.projectConfigDir ? `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(opts.projectConfigDir)}` : '',
      'log() { echo "LOG: $*" >&2; }',
      'warning() { echo "WARN: $*" >&2; }',
      FN_BODY,
      `run_anti_pattern_check ${JSON.stringify(dir)} ${JSON.stringify(outLog)} ${JSON.stringify(opts.storyId ?? 'AMSD-2041')}`,
      'echo "RC=$?"',
      'echo "VF=$VERIFICATION_FAILURE"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const output = (result.stdout || '') + (result.stderr || '');
  const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
  return { rc, output };
}

describe('run_anti_pattern_check — no config means a silent no-op', () => {
  it('returns 0 when EPAM_PROJECT_CONFIG_DIR is unset', () => {
    const { rc } = runCheck({
      projectConfigDir: null,
      files: { 'src/x.ts': 'live_preview: { management_token: "x" }' },
    });
    expect(rc).toBe(0);
  });

  it('returns 0 when the project directory has no anti-patterns.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-cfg-'));
    cleanupDirs.push(dir);
    const { rc } = runCheck({
      projectConfigDir: dir,
      files: { 'src/x.ts': 'live_preview: { management_token: "x" }' },
    });
    expect(rc).toBe(0);
  });

  it('returns 0 (never blocks) when anti-patterns.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-cfg-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), '{ not valid json');
    const { rc } = runCheck({
      projectConfigDir: dir,
      files: { 'src/x.ts': 'live_preview: { management_token: "x" }' },
    });
    expect(rc).toBe(0);
  });
});

describe('run_anti_pattern_check — REPRODUCES the exact live regression', () => {
  it('blocks when a story-owned file regresses to management_token inside live_preview', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-cfg-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);
    const { rc, output } = runCheck({
      projectConfigDir: dir,
      files: {
        'src/services/contentstack.ts': `
export const options = {
  ...(CONTENTSTACK_PREVIEW_TOKEN
    ? {
        live_preview: {
          enable: true,
          management_token: CONTENTSTACK_PREVIEW_TOKEN,
        },
      }
    : {}),
};
`,
      },
    });
    expect(rc).toBe(1);
    expect(output).toMatch(/management_token/);
    expect(output).toMatch(/VF=[\s\S]*previously-diagnosed wrong pattern/);
  });

  it('does NOT block the correct preview_token usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-cfg-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);
    const { rc } = runCheck({
      projectConfigDir: dir,
      files: {
        'src/services/contentstack.ts': `
export const options = {
  ...(CONTENTSTACK_PREVIEW_TOKEN
    ? { live_preview: { enable: true, preview_token: CONTENTSTACK_PREVIEW_TOKEN } }
    : {}),
};
`,
      },
    });
    expect(rc).toBe(0);
  });

  it('does NOT block a file the current story does not own (scoped, same lesson as relative-import-check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-cfg-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);
    const { rc } = runCheck({
      projectConfigDir: dir,
      files: {
        'src/services/contentstack.ts': 'live_preview: { management_token: "x" }',
        'src/unrelated.ts': 'export const y = 1;',
      },
      ownedFiles: ['src/unrelated.ts'],
    });
    expect(rc).toBe(0);
  });
});

/**
 * Full branch/boundary coverage for `matchPattern`
 * (`live_preview\s*:\s*\{[^}]*management_token`) — per the standing rule
 * (feedback_regex_100_percent_coverage, 2026-08-02): every regex used
 * anywhere in this codebase gets 100% branch coverage, not a representative
 * sample.
 *
 * Also reproduces the exact live regression this pattern was reverted to fix:
 * a briefly-shared, loosened bidirectional pattern (moved to a SEPARATE
 * `textMatchPattern` field, see skill-note-anti-pattern-gate.test.ts) false-
 * positived on real, correct, review-approved code in
 * next.metrolinx.com/src/services/contentstack.ts — a comment explaining
 * "the delivery SDK reads `preview_token` (not `management_token`)" sits
 * near `live_preview` in the same file, and the loosened pattern matched it
 * regardless of order or comment-vs-code position. `matchPattern` (this
 * file's contract) must NEVER match prose/comments — only the literal
 * structural shape `live_preview: { ...management_token }`.
 */
describe('run_anti_pattern_check — matchPattern (code regex): full branch coverage', () => {
  function checkOne(code: string): number {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-branch-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);
    const { rc } = runCheck({ projectConfigDir: dir, files: { 'src/x.ts': code } });
    return rc;
  }

  it('MATCH: exact minimal shape, no whitespace', () => {
    expect(checkOne('live_preview:{management_token')).toBe(1);
  });

  it('MATCH: whitespace around colon and brace', () => {
    expect(checkOne('live_preview  :  {  management_token')).toBe(1);
  });

  it('MATCH: newline between colon and brace', () => {
    expect(checkOne('live_preview\n  : \n {\n  management_token')).toBe(1);
  });

  it('MATCH: other keys present before management_token inside the same object', () => {
    expect(checkOne('live_preview: { enable: true, management_token: X, foo: 1 }')).toBe(1);
  });

  it('NO MATCH: correct code — only preview_token inside the object, no management_token anywhere', () => {
    expect(checkOne('live_preview: { enable: true, preview_token: X }')).toBe(0);
  });

  it("NO MATCH: REPRODUCES the exact live regression — management_token mentioned in a comment BEFORE live_preview, real code shape", () => {
    // Verbatim structure from next.metrolinx.com/src/services/contentstack.ts
    // (the real file that triggered the live false positive).
    expect(
      checkOne(`
// The delivery SDK reads \`preview_token\` (not
// \`management_token\`) from the \`live_preview\` config block — using the wrong
// key silently disables preview.
export const options = {
  live_preview: { enable: true, preview_token: CONTENTSTACK_PREVIEW_TOKEN },
};
`),
    ).toBe(0);
  });

  it('NO MATCH: management_token mentioned in a comment immediately AFTER the live_preview object closes', () => {
    expect(
      checkOne(`
live_preview: { enable: true, preview_token: X },
// note: the SDK's stale type declares management_token as required — ignore it
`),
    ).toBe(0);
  });

  it('NO MATCH: management_token appears in a DIFFERENT, unrelated object (a } intervenes before it)', () => {
    expect(checkOne('live_preview: { enable: true }; const other = { management_token: X };')).toBe(0);
  });

  it('NO MATCH: "live_preview" appears with no object literal at all (plain identifier/string)', () => {
    expect(checkOne('const live_preview = "management_token is mentioned here as plain text";')).toBe(0);
  });

  it('NO MATCH: management_token appears, but live_preview does not appear anywhere', () => {
    expect(checkOne('const management_token = "unrelated field entirely";')).toBe(0);
  });
});
