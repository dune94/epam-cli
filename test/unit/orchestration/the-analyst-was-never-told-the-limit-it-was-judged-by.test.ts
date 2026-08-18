// THE ANALYST WAS NEVER TOLD THE LIMIT ITS ANSWER WAS JUDGED BY.
//
// A skill note must be a single imperative line under 200 characters — it is injected into a
// retry prompt and can persist into an agent's profile, so the limit is real and stays.
//
// The failure-analyst template specifies the shape in detail: open with an imperative verb, be a
// concrete do/don't, be actionable without further interpretation. It never states the length.
// So the analyst writes past it, the reviewer rejects on length, and a summarizer rewrites —
// a full model round trip per attempt. Live 2026-08-18, both lanes, every attempt:
//
//   [FailureAnalyst] Injected skill guidance into retry prompt (331 chars)
//   [PRD-Reviewer] REJECTED skill_note for MOCK3-1: 331 characters, exceeding the 200-character
//                  limit. Shorten to a concise imperative under 200 chars, e.g.: '...'
//   [PRD-Summarizer] Rewriting rejected skill_note (attempt 1/3)
//
// The rejection message even contains a perfectly good 96-character version — the reviewer knows
// the answer and discards the analyst's instead of using it. Both lanes spent roughly three
// attempts of their twelve on this before the guidance landed intact.
//
// This is the pattern the roster's `rationale` already follows: mergeProjectAgents refuses a
// rationale below a minimum length, so the mint's schema STATES that minimum rather than letting
// the model discover it as a rejection. The number is declared once and read by everyone who
// asserts it — the checker, and the producer that must satisfy it.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CFG = join(ROOT, 'orchestrations/config/self-heal.json');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const TPL = join(ROOT, 'orchestrations/prompts/templates/failure-analyst.json');

const config = () => JSON.parse(readFileSync(CFG, 'utf8'));

/** Run the real _skill_note_format_ok against a note of a given length. */
function accepts(note: string) {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const m = src.match(/^_skill_note_format_ok\(\)\s*\{[\s\S]*?\n\}/m);
  const h = src.match(/^_skill_note_max_chars\(\)\s*\{[\s\S]*?\n\}/m);
  if (!m) throw new Error('claude.sh has no _skill_note_format_ok()');
  if (!h) throw new Error('claude.sh has no _skill_note_max_chars()');
  const r = spawnSync('bash', ['-c',
    `SKILL_NOTE_IMPERATIVE_OPENERS='Use|Always|Never|Prefer|Avoid|Add|Declare'\n`
    + `AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}\n`
    + `${h[0]}\n${m[0]}\n_skill_note_format_ok ${JSON.stringify(note)} "" ""`,
  ], { encoding: 'utf8' });
  return r.status === 0;
}

describe('the analyst was never told the limit it was judged by', () => {
  it('THE LIMIT IS DECLARED ONCE, AS DATA', () => {
    expect(existsSync(CFG), 'the skill-note limit is still a literal in code').toBe(true);
    const max = config()?.skillNote?.maxChars;
    expect(typeof max, 'self-heal.json declares no skillNote.maxChars').toBe('number');
    expect(max).toBeGreaterThan(0);
  });

  it('THE CHECKER READS IT — not a number written beside it', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const fn = src.match(/^_skill_note_format_ok\(\)\s*\{[\s\S]*?\n\}/m)![0];
    expect(fn, 'the checker still compares against a hardcoded length')
      .not.toMatch(/-le\s+200\b/);
    expect(fn, 'the checker does not read the declared limit')
      .toMatch(/_skill_note_max_chars/);
  });

  it('ENFORCES THE DECLARED LIMIT — at it passes, over it fails', () => {
    const max = config().skillNote.maxChars as number;
    expect(accepts('Always ' + 'x'.repeat(max - 'Always '.length)),
      'a note exactly at the limit was rejected').toBe(true);
    expect(accepts('Always ' + 'x'.repeat(max)),
      'a note over the limit was accepted').toBe(false);
  });

  it('AND THE ANALYST IS TOLD IT — the round trip this removes', () => {
    const tpl = JSON.parse(readFileSync(TPL, 'utf8'));
    expect(tpl.placeholders, 'the analyst template declares no limit placeholder')
      .toContain('__SKILL_NOTE_MAX__');
    expect(tpl.body, 'the template never mentions the length its answer is judged by')
      .toMatch(/__SKILL_NOTE_MAX__/);
  });

  it('THE CALLER SUPPLIES IT FROM THE SAME DECLARATION — not a second copy', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('"__ANALYST_PROFILE__":$profile');
    const block = src.slice(start, src.indexOf('> "$_analyst_values"', start));
    expect(block, 'the analyst values block never supplies __SKILL_NOTE_MAX__')
      .toContain('__SKILL_NOTE_MAX__');
    const i = src.lastIndexOf('self-heal.json', start);
    expect(i, 'the limit handed to the analyst does not come from the declaration')
      .toBeGreaterThan(-1);
  });

  it('the number is not restated anywhere it could drift from', () => {
    // The producer must read it, never carry its own copy.
    const tpl = JSON.parse(readFileSync(TPL, 'utf8'));
    expect(tpl.body, 'the analyst template hardcodes a length beside the placeholder')
      .not.toMatch(/\b200\b/);
  });
});
