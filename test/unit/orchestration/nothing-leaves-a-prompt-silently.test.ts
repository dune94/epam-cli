/**
 * NOTHING LEAVES A PROMPT SILENTLY.
 *
 * The coordinator amendment grows every retry, and past a threshold the oldest sections are
 * dropped so the prompt stays bounded. That is sound — an agent re-reading every prior attempt's
 * guidance is waste — but the writer was never TOLD, so guidance it had been given simply ceased
 * to exist from its point of view, with no way to ask for it.
 *
 * It is the same fault as every ceiling found on 2026-09-22/23: evidence removed without a word.
 * The analyst's remedy was cut at 200 characters, the writer saw 60 lines of a failing suite, the
 * suite that never ran read as "nothing new failed". In each case the loss was silent, so nobody
 * could act on it — including the agent that needed it.
 *
 * Executes the REAL handler (lib/handlers/trim-coordinator-amendment.py).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/trim-coordinator-amendment.py');

/** An amendment with `n` guidance sections, oldest first, as retries accumulate them. */
function amendment(n: number) {
  return Array.from({ length: n }, (_, i) =>
    `## Guidance after attempt ${i}\nDo not reuse the validation helper from attempt ${i}.\nEvidence: line ${i}.`,
  ).join('\n');
}

function trim(text: string, keep: number) {
  const r = spawnSync('python3', [HANDLER], {
    input: text, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, EPAM_PROMPT_TRIM_KEEP: String(keep) },
  });
  return (r.stdout || '') + (r.stderr || '');
}

describe('nothing leaves a prompt silently', () => {
  it('keeps the most recent sections (unchanged behaviour)', () => {
    const out = trim(amendment(6), 3);
    expect(out).toContain('## Guidance after attempt 5');
    expect(out).toContain('## Guidance after attempt 3');
    expect(out, 'an older section survived the trim').not.toContain('## Guidance after attempt 1');
  });

  it('SAYS that earlier guidance was dropped, and how much', () => {
    const out = trim(amendment(6), 3);
    expect(out, 'three sections vanished from the prompt without a word').toMatch(/\b3\b/);
    expect(out.toLowerCase()).toMatch(/earlier|previous|dropped|trimmed|omitted/);
  });

  it('says WHERE the full history is, so the agent can read what it lost', () => {
    const out = trim(amendment(6), 3);
    expect(out, 'nothing points at the scratchpad the full prompt was written to')
      .toMatch(/scratchpad|kb-scratchpad|full history|written to/i);
  });

  it('says nothing when nothing was dropped — no noise on the common path', () => {
    const out = trim(amendment(2), 3);
    expect(out).toContain('## Guidance after attempt 0');
    expect(out.toLowerCase()).not.toMatch(/dropped|trimmed|omitted/);
  });

  it('an amendment with no sections at all passes through untouched', () => {
    const out = trim('a bare note with no headings', 3);
    expect(out.trim()).toBe('a bare note with no headings');
  });
});
