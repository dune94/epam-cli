/**
 * NO SHIPPED PROMPT ENDS MID-SENTENCE.
 *
 * assign-agent-roles.json ended, in every commit it has ever had:
 *
 *   "... Where the story needs\nboth console configuration and code, "
 *
 * A trailing comma and a space. The paragraph states a rule and stops before saying what the rule
 * IS, so role-assigner has always been given an unfinished instruction at the exact point the
 * instruction mattered. Nothing caught it: the template parsed, rendered, declared its
 * placeholders, and passed every existing check, because none of them read the last sentence.
 *
 * This is cheap to hold for every template, so it is held for every template.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = join(__dirname, '../../../orchestrations/prompts/templates');

/** Every renderable body a template ships. */
const bodies = (t: Record<string, unknown>): string[] => (
  t.bodies && typeof t.bodies === 'object'
    ? Object.values(t.bodies as Record<string, string>)
    : [String(t.body || '')]
);

describe('every template body is a finished instruction', () => {
  const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'));

  it('there are templates to check', () => {
    expect(files.length, 'no templates found — this suite would prove nothing')
      .toBeGreaterThan(10);
  });

  for (const f of files) {
    it(`${f} does not stop mid-sentence`, () => {
      const t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
      for (const body of bodies(t)) {
        const text = body.trim();
        if (!text) continue;
        // A body may legitimately end on a placeholder, a colon-led list, a fence or a bullet.
        // What it may never do is end on a dangling connective — a comma, "and", "or", "the".
        expect(text, `${f} ends mid-sentence: ...${JSON.stringify(text.slice(-70))}`)
          .not.toMatch(/(,|\b(and|or|the|a|an|to|of|that|which|where|when|with|for)\b)$/i);
      }
    });
  }
});
