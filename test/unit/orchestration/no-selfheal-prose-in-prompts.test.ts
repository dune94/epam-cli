/**
 * STANDING RULE, enforced by test: self-heal knowledge never reaches an agent as
 * prompt text.
 *
 * Healed knowledge arrives only as structure — env exports, KB_GATES,
 * KB_PRE_EXEC_BLOCKS, EPAM_RESPONSE_SCHEMA — compiled from constraints that
 * Pydantic has already validated. Prose appendices are banned because they are
 * silently trimmed on long runs (the old path cut to the last three headings past
 * ~16000 chars) and nothing verifies the agent obeyed them.
 *
 * EXPLICITLY ALLOWED, and not what this guards: a gate rejection returned as a
 * TOOL RESULT ("rejected by KB gate <id>: ..."). That is in-band, deterministic,
 * tied to the exact call, and verifiable — the same category as an OS permission
 * error. Without it an agent hits an invisible wall and retries blindly.
 *
 * This is a registry-shaped guard rather than a test per site: the channels that
 * existed (CORRECTIVE GUIDANCE FROM SELF-HEAL, TC_WRITER_CORRECTIVE) were added
 * one at a time by well-meaning changes, and the next one would be too.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

function shellFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return shellFiles(p);
    return /\.(sh|js)$/.test(name) ? [p] : [];
  });
}

/** Phrases that only make sense as text addressed to a model. */
const PROSE_CHANNELS = [
  /CORRECTIVE GUIDANCE FROM SELF-HEAL/,
  /TC_WRITER_CORRECTIVE/,
  /COORDINATOR_PROMPT_AMENDMENT\s*=\s*"\$\{?_?corrective/i,
];

describe('no self-heal prose may be pushed into an agent prompt', () => {
  const files = shellFiles(SCRIPTS);

  it('finds the pipeline scripts (guard is actually scanning something)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const pattern of PROSE_CHANNELS) {
    it(`no script reintroduces ${pattern.source.slice(0, 44)}`, () => {
      const offenders = files.filter(f => {
        const src = readFileSync(f, 'utf8');
        // Ignore the rule's own explanatory comments.
        const code = src.split('\n').filter(l => !/^\s*(#|\*|\/\/)/.test(l)).join('\n');
        return pattern.test(code);
      }).map(f => f.replace(SCRIPTS + '/', ''));
      expect(offenders,
        'self-heal knowledge is being injected into a prompt — it must compile to ' +
        'enforcement (param / tool_scope / gate / pre_exec_block / response_schema) instead')
        .toEqual([]);
    });
  }

  it('the analyst returns no text for a caller to prepend', () => {
    const src = readFileSync(join(SCRIPTS, 'agent-attempt-analyst.sh'), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    expect(code,
      'the analyst prints its directive again — that is the banned channel reopened')
      .not.toMatch(/printf '%s' "\$_trimmed"/);
  });

  it('enforcement still reaches the retry — removing prose must not remove self-heal', () => {
    const src = readFileSync(join(SCRIPTS, 'brownfield-repro-test-writer.sh'), 'utf8');
    expect(src,
      'prose was removed without applying the constraint, so retries now get NOTHING')
      .toMatch(/kb_apply_constraints/);
  });
});
