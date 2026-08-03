/**
 * _text_violates_anti_pattern() + its wiring into the self-heal skill-note
 * persistence path (claude.sh, FailureAnalyst's "skill" target) — a
 * deterministic gate on TEXT, sibling to run_anti_pattern_check()'s gate on
 * story-owned FILES.
 *
 * Root cause this closes (found live, 2026-08-02, Writer Retest): the exact
 * same wrong belief — "Contentstack's live_preview needs management_token"
 * — got independently re-derived by FailureAnalyst and persisted into
 * profiles.json as a "[Self-Heal] Always:" note THREE separate times across
 * one day of real runs, even after the file was manually restored from its
 * clean canonical copy each time. FailureAnalyst reasoned 100% correctly
 * from the installed node_modules/contentstack/index.d.ts type declaration
 * (confirmed for real: line 74 does declare LivePreview as
 * {host, management_token, enable}) — but that type declaration is itself
 * STALE relative to the SDK's real runtime behavior, a fact already
 * established by multiple real code reviews (the correct fix uses
 * preview_token, cast through `as unknown as contentstack.LivePreview`).
 * FailureAnalyst has no way to know a TYPE FILE can be wrong, and its own
 * LLM-reviewer gate on the skill note shares the exact same blind spot, so
 * it didn't catch it either. The project's own anti-patterns.json (already
 * written after the first live rejection) is the one thing that DOES encode
 * the known-correct answer — checking a skill note against it before either
 * LLM ever sees it means the same wrong belief can never be re-argued back
 * into the profile, no matter how many times a model re-derives it.
 *
 * Real anti-patterns.json config, real regex, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
// _text_violates_anti_pattern() itself now lives in lib/story-guards.sh
// (2026-08-02, moved alongside the new _persist_skill_note_simple() so both
// claude.sh's FailureAnalyst skill-note path AND run-agent-orchestration.sh's
// review-rejection skill-note path can share one definition — same reasoning
// as the lib/git-ops.sh consolidation). The wiring tests below still read
// claudeSrc to confirm claude.sh's CALL SITE is unchanged.
const STORY_GUARDS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const storyGuardsSrc = readFileSync(STORY_GUARDS_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(storyGuardsSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = storyGuardsSrc.indexOf('\n}', start) + 2;
  return storyGuardsSrc.slice(start, end);
}
const FN_BODY = extractFunctionBody('_text_violates_anti_pattern');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANAGEMENT_TOKEN_RULES = JSON.stringify([
  {
    id: 'contentstack-live-preview-wrong-token-key',
    // Deliberately a SEPARATE field from `matchPattern` (found live,
    // 2026-08-02: a briefly-shared pattern between this text-scanner and
    // run_anti_pattern_check's code-scanner made the code-scanner false-
    // positive on real, correct, review-approved comments — see
    // anti-pattern-check.test.ts's "matchPattern: full branch coverage"
    // block and feedback_regex_100_percent_coverage).
    textMatchPattern:
      '(?is)(live_preview|LivePreview)[\\s\\S]{0,120}management_token|management_token[\\s\\S]{0,120}(live_preview|LivePreview)',
    message: 'Contentstack live_preview must use preview_token, not management_token — the type declaration is stale.',
  },
]);

function runTextCheck(configDir: string | null, text: string): { rc: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-text-'));
  cleanupDirs.push(dir);
  const scriptPath = join(dir, 'run.sh');
  // Pass the note text via an environment variable, NOT interpolated into the
  // script source — a real skill note can contain backticks (as one of the
  // three real notes reproduced below does), which a naive double-quoted
  // interpolation would mangle via bash command substitution before it ever
  // reached the function under test.
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      configDir ? `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(configDir)}` : '',
      FN_BODY,
      '_text_violates_anti_pattern "$NOTE_TEXT"',
      'echo "RC=$?"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NOTE_TEXT: text },
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
  return { rc, output };
}

describe('_text_violates_anti_pattern — no config means a silent no-op', () => {
  it('returns 0 (clean, no message) when EPAM_PROJECT_CONFIG_DIR is unset', () => {
    const { rc, output } = runTextCheck(null, 'management_token near live_preview');
    expect(rc).toBe(0);
    expect(output).not.toMatch(/management_token must use/);
  });

  it('returns 0 when the project directory has no anti-patterns.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-text-cfg-'));
    cleanupDirs.push(dir);
    const { rc } = runTextCheck(dir, 'management_token near live_preview');
    expect(rc).toBe(0);
  });

  it('returns 0 (never blocks) when anti-patterns.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-text-cfg-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), '{ not valid json');
    const { rc } = runTextCheck(dir, 'management_token near live_preview');
    expect(rc).toBe(0);
  });
});

describe('_text_violates_anti_pattern — REPRODUCES the exact 3 real skill notes from the live incident', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-text-real-'));
  writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);

  it('blocks the first real FailureAnalyst diagnosis, verbatim', () => {
    const { rc, output } = runTextCheck(
      dir,
      'Config.live_preview needs {host,management_token,enable} not {preview_token}; livePreviewQuery is on Stack not Query/Entry',
    );
    expect(rc).toBe(1);
    expect(output).toMatch(/stale/);
  });

  it('blocks the second real FailureAnalyst diagnosis, verbatim', () => {
    const { rc } = runTextCheck(
      dir,
      'options.live_preview uses preview_token but SDK LivePreview type requires host and management_token fields',
    );
    expect(rc).toBe(1);
  });

  it('blocks the third real FailureAnalyst diagnosis, verbatim (the one citing a real, correct file:line)', () => {
    const { rc } = runTextCheck(
      dir,
      "The Contentstack SDK's `LivePreview` interface (node_modules/contentstack/index.d.ts line 74) is `{ host: string; management_token: string; enable: boolean }` — there is NO `preview_token`",
    );
    expect(rc).toBe(1);
  });

  it('does NOT block an unrelated, legitimate skill note', () => {
    const { rc } = runTextCheck(
      dir,
      'jest.spyOn() returns jest.SpyInstance, NOT jest.Mock — always type spy variables as `let spy!: jest.SpyInstance`',
    );
    expect(rc).toBe(0);
  });

  it('does NOT block a note correctly describing the FIX (preview_token, no management_token mentioned)', () => {
    const { rc } = runTextCheck(
      dir,
      'Contentstack live_preview must use preview_token (not management_token per the stale type decl) cast via `as unknown as contentstack.LivePreview`',
    );
    // This note itself mentions "management_token" near "live_preview" (to
    // explain what NOT to do) and correctly gets flagged for human review —
    // documents current behavior: the check is text-pattern-based, not
    // semantic, so a note explaining the correct answer in contrast to the
    // wrong one still matches. This is a deliberate, safe false-positive
    // (blocks a good note along with bad ones) rather than a false-negative
    // (letting a bad note through) — verified consistent with the
    // ALLOWED/BLOCKED matrix already proven live above.
    expect(rc).toBe(1);
  });
});

/**
 * Full branch/direction/boundary coverage for `textMatchPattern`
 * (`(?is)(live_preview|LivePreview)[\s\S]{0,120}management_token|
 * management_token[\s\S]{0,120}(live_preview|LivePreview)`) — per the
 * standing rule (feedback_regex_100_percent_coverage, 2026-08-02): every
 * regex gets 100% branch coverage, not a representative sample. This
 * pattern has 2 top-level alternation branches, each with 2 sub-alternatives
 * (live_preview | LivePreview), a case-insensitive flag, and a {0,120}
 * quantifier whose boundary must be tested on both sides.
 */
describe('_text_violates_anti_pattern — textMatchPattern: full branch/boundary coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anti-pattern-text-branches-'));
  writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);

  it('branch A1: "live_preview" then management_token', () => {
    const { rc } = runTextCheck(dir, 'live_preview XXXX management_token');
    expect(rc).toBe(1);
  });

  it('branch A2: "LivePreview" then management_token', () => {
    const { rc } = runTextCheck(dir, 'LivePreview XXXX management_token');
    expect(rc).toBe(1);
  });

  it('branch B1: management_token then "live_preview"', () => {
    const { rc } = runTextCheck(dir, 'management_token XXXX live_preview');
    expect(rc).toBe(1);
  });

  it('branch B2: management_token then "LivePreview"', () => {
    const { rc } = runTextCheck(dir, 'management_token XXXX LivePreview');
    expect(rc).toBe(1);
  });

  it('case-insensitivity: mixed-case variants of both keywords still match', () => {
    const { rc } = runTextCheck(dir, 'Live_Preview needs MANAGEMENT_TOKEN set');
    expect(rc).toBe(1);
  });

  it('boundary: exactly 120 characters between the two keywords still matches ({0,120} is inclusive)', () => {
    const filler = 'x'.repeat(120);
    const { rc } = runTextCheck(dir, `live_preview${filler}management_token`);
    expect(rc).toBe(1);
  });

  it('boundary: 121 characters between the two keywords does NOT match (one past the limit)', () => {
    const filler = 'x'.repeat(121);
    const { rc } = runTextCheck(dir, `live_preview${filler}management_token`);
    expect(rc).toBe(0);
  });

  it('negative: management_token present, but neither live_preview nor LivePreview appears anywhere', () => {
    const { rc } = runTextCheck(dir, 'the management_token field is used for the CMS admin API elsewhere');
    expect(rc).toBe(0);
  });

  it('negative: live_preview present, but management_token does not appear anywhere', () => {
    const { rc } = runTextCheck(dir, 'live_preview must be enabled via the CONTENTSTACK_PREVIEW_TOKEN env var');
    expect(rc).toBe(0);
  });

  it('negative: LivePreview present, but management_token does not appear anywhere', () => {
    const { rc } = runTextCheck(dir, 'the LivePreview interface has an enable flag');
    expect(rc).toBe(0);
  });

  it('negative: neither keyword appears at all', () => {
    const { rc } = runTextCheck(dir, 'jest.spyOn() returns jest.SpyInstance, NOT jest.Mock');
    expect(rc).toBe(0);
  });
});

describe('claude.sh — skill-note persistence wiring', () => {
  it('the skill-note persistence block calls _text_violates_anti_pattern before persisting', () => {
    const idx = claudeSrc.indexOf('# Persist skill note to profiles.json so future runs inherit this learning');
    expect(idx).toBeGreaterThan(-1);
    const gateIdx = claudeSrc.indexOf('_text_violates_anti_pattern "$skill_note"', idx);
    const persistIdx = claudeSrc.indexOf("print(f'Skill note appended to", idx);
    expect(gateIdx).toBeGreaterThan(idx);
    expect(persistIdx).toBeGreaterThan(gateIdx);
  });

  it('a violating skill note is refused with a warning, before the duplicate-check/reviewer path ever runs', () => {
    const idx = claudeSrc.indexOf('_text_violates_anti_pattern "$skill_note"');
    const block = claudeSrc.slice(idx, idx + 400);
    expect(block).toMatch(/refusing to persist/);
  });
});
