/**
 * THE BIGGEST LEVER ON WRITER PROMPT SIZE WAS A LITERAL IN THE MIDDLE OF A FUNCTION.
 *
 * The writer prompt injects the content of every declared file under "## Existing File Contents
 * (injected once, deterministically — do NOT ReadFile these)". Measured live on AMSD-2041 that
 * block was 34,510 of 86,809 chars — 39% of the prompt, paid again on every one of up to 8
 * attempts.
 *
 * How much of each file goes in was `local _EXISTING_FILE_MAX_LINES=400`, a literal an operator
 * could not change without editing code — the same shape as the 16000 trim threshold and the
 * keep-count of 3, both of which have already moved to spec-mode-defaults.json.
 *
 * It matters more than the others because it is the term that dominates: the trim can only cut
 * accumulated guidance, and no amount of trimming reduces the injected files. Lowering this
 * shrinks the prompt directly and pushes the writer toward codegraph_query and ReadFile for what
 * it actually needs, which is what those tools are for.
 *
 * Truncation must stay visible either way — a file silently cut at N lines is how an agent comes
 * to believe an export does not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const CONFIG = join(ROOT, 'orchestrations/config/spec-mode-defaults.json');
const BUDGET_SH = join(ROOT, 'orchestrations/scripts/lib/prompt-budget.sh');

describe('the injection budget is configuration, not a literal', () => {
  it('spec-mode-defaults.json carries it', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.promptTrim ?? cfg.existingFileInjection, 'no budget section at all').toBeTruthy();
    const v = cfg.existingFileInjection?.maxLinesPerFile;
    expect(v, 'maxLinesPerFile is not configured').toBeTypeOf('number');
    expect(v).toBeGreaterThan(0);
  });

  it('it is overridable by an environment variable, like every other budget here', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.existingFileInjection?.maxLinesPerFileEnv).toBeTruthy();
  });

  it('lib/prompt-budget.sh exposes an accessor for it', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(BUDGET_SH)} >/dev/null 2>&1; existing_file_max_lines`,
    ], { encoding: 'utf8' }).trim();
    expect(Number(out), 'the accessor returned nothing usable').toBeGreaterThan(0);
  });

  it('the environment override actually wins', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(BUDGET_SH)} >/dev/null 2>&1
       EPAM_EXISTING_FILE_MAX_LINES=25 existing_file_max_lines`,
    ], { encoding: 'utf8' }).trim();
    expect(out).toBe('25');
  });

  it('claude.sh reads the accessor rather than a baked-in number', () => {
    expect(CLAUDE_SH, 'the literal is still there').not.toMatch(/_EXISTING_FILE_MAX_LINES=400/);
    expect(CLAUDE_SH).toMatch(/existing_file_max_lines/);
  });

  it('truncation is still announced to the writer', () => {
    // A file silently cut at N lines is how an agent concludes an export does not exist and
    // invents a plausible one instead — the failure this whole block was added to prevent.
    expect(CLAUDE_SH).toMatch(/truncated at .* lines/);
    expect(CLAUDE_SH).toMatch(/ReadFile this path yourself/);
  });
});
