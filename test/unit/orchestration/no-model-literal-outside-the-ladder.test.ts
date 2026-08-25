/**
 * THE LADDERS DICTATE EVERY MODEL CALL — NO EXCEPTIONS.
 *
 * A model name written into a script is a second source of truth for a decision the ladders own,
 * and it wins silently whenever the ladder does not resolve. Live consequences, all measured:
 *
 *   claude.sh:385-387   EFFORT_MODEL_LOW/MEDIUM/HIGH all defaulted to `gpt-5-codex` — one model
 *                       for all three tiers, and one with no entry in ANY ladder. The effort axis
 *                       collapsed to a constant, which is why 205 of 211 archived story records
 *                       carry the same assigned model.
 *   claude.sh:2004      `--model "${STORY_MODEL:-gpt-5-codex}"` — a literal at the invocation
 *                       itself, so an unresolved story model called a foreign vendor rather than
 *                       failing.
 *
 * The rule this asserts: in the LIVE path, a model name may be READ from configuration or a
 * ladder, never SUBSTITUTED as a default. When nothing resolves, the run must fail loudly — a
 * wrong model is more expensive than a stopped run, and far harder to notice.
 *
 * Scoped to the scripts a metrolinx run actually executes. Mock and other-tier launchers set their
 * own ladders explicitly and are listed as out of scope rather than silently skipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/** The scripts a live metrolinx run executes. */
const LIVE_PATH = [
  'claude.sh',
  'ai-run.sh',
  'run-agent-orchestration.sh',
  'contextualize-stories.sh',
  'lib/model-ladders.sh',
  'lib/seam-ladder.sh',
];

/**
 * A vendor model name. Deliberately broad: the point is that NO literal appears, so the pattern
 * must catch a model this project has never used as readily as one it has.
 */
const MODEL_LITERAL = /(gpt-[0-9][a-z0-9.-]*|claude-(?:opus|sonnet|haiku)[a-z0-9.-]*|MiniMax-M[0-9][a-z0-9.-]*|z-ai\/glm-[0-9][a-z0-9.-]*|moonshotai\/kimi-[a-z0-9.-]+|zhipuai\/[a-z0-9.-]+)/;

/** A literal used as a DEFAULT or FALLBACK — `${X:-model}`, `X=model`, `--model model`. */
const substituted = (line: string): string | null => {
  const stripped = line.replace(/#.*$/, '');
  if (!stripped.trim()) return null;
  for (const re of [/:-\s*"?([^"}\s]+)"?\s*}/g, /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*="?([^"\s]+)"?\s*$/g, /--model\s+"?([^"\s]+)"?/g]) {
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(stripped))) {
      const v = m[1].replace(/^\$\{?|\}?$/g, '');
      if (MODEL_LITERAL.test(v)) return m[0].trim();
    }
  }
  return null;
};

describe('no live-path script substitutes a model name', () => {
  it('the scan actually reads the scripts — otherwise it proves nothing', () => {
    const total = LIVE_PATH.reduce((n, f) => n + readFileSync(join(SCRIPTS, f), 'utf8').length, 0);
    expect(total).toBeGreaterThan(10000);
  });

  it('the detector can see a violation when there is one', () => {
    // Calibration: a scanner that cannot fail is not a check.
    expect(substituted('EFFORT_MODEL_LOW="${EPAM_EFFORT_MODEL_LOW:-gpt-5-codex}"')).toBeTruthy();
    expect(substituted('  --model "${STORY_MODEL:-gpt-5-codex}" \\')).toBeTruthy();
    expect(substituted('STORY_MODEL="$EFFORT_MODEL_LOW"'), 'a variable is not a literal').toBeNull();
  });

  for (const f of LIVE_PATH) {
    it(`${f} names no model as a default`, () => {
      const bad: string[] = [];
      readFileSync(join(SCRIPTS, f), 'utf8').split('\n').forEach((line, i) => {
        const hit = substituted(line);
        if (hit) bad.push(`${f}:${i + 1}  ${hit}`);
      });
      expect(bad,
        `a model name is substituted where the ladder should decide:\n  ${bad.join('\n  ')}`)
        .toEqual([]);
    });
  }
});
