/**
 * Regression guard for a live-run defect (tier3 scaffold run, 2026-07-02):
 * Step 0.5's assessment_prompt heredoc uses an UNQUOTED delimiter
 * (`<< PROMPT_HEADER`, not `<< 'PROMPT_HEADER'`) because it needs
 * ${phase_id}/${PRD_REL} variable expansion. But the prompt text also
 * contained unescaped backticks around code examples (`process.env.
 * SKYSCANNER_API_KEY`, etc) — bash treated those as command substitution,
 * producing "command not found" errors and corrupting the actual prompt
 * text sent to the LLM.
 *
 * Fix: escape the backticks (\`...\`) so they survive literally through an
 * unquoted heredoc while ${var} expansion still works.
 *
 * This test scans every unquoted heredoc body in the orchestration scripts
 * for unescaped backticks, so this class of bug can't reappear silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPTS_DIR = join(REPO_ROOT, 'orchestrations/scripts');

// Extract [{ file, delimiter, body }] for every heredoc in a shell script's source.
// Only unquoted delimiters (<<DELIM, << DELIM, <<-DELIM) are returned — quoted
// delimiters (<< 'DELIM' or << "DELIM") suppress all expansion, so backticks
// there are always literal and safe.
function findUnquotedHeredocs(src: string): { delimiter: string; body: string }[] {
  const results: { delimiter: string; body: string }[] = [];
  const openRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(src)) !== null) {
    const quote = match[1];
    const delimiter = match[2];
    if (quote === "'" || quote === '"') continue; // quoted — expansion suppressed, safe
    const bodyStart = match.index + match[0].length;
    // Find the closing delimiter on its own line (allow leading whitespace for <<-)
    const closeRe = new RegExp(`\\n[ \\t]*${delimiter}\\b`);
    const closeMatch = closeRe.exec(src.slice(bodyStart));
    if (!closeMatch) continue;
    const body = src.slice(bodyStart, bodyStart + closeMatch.index);
    results.push({ delimiter, body });
  }
  return results;
}

// A backtick is unsafe if it is not preceded by a backslash.
function hasUnescapedBacktick(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '`' && body[i - 1] !== '\\') return true;
  }
  return false;
}

describe('heredoc backtick safety — unquoted heredocs must escape backticks', () => {
  const shellFiles = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join(SCRIPTS_DIR, f));

  it('found at least one shell script to scan (sanity check)', () => {
    expect(shellFiles.length).toBeGreaterThan(0);
  });

  for (const file of shellFiles) {
    const rel = file.replace(REPO_ROOT, '');
    it(`${rel} — no unescaped backticks inside unquoted heredoc bodies`, () => {
      const src = readFileSync(file, 'utf8');
      const heredocs = findUnquotedHeredocs(src);
      const offenders = heredocs.filter((h) => hasUnescapedBacktick(h.body));
      if (offenders.length > 0) {
        const preview = offenders
          .map((h) => `  <<${h.delimiter}: ...${h.body.match(/.{0,40}`.{0,40}/)?.[0] ?? ''}...`)
          .join('\n');
        throw new Error(
          `${offenders.length} unquoted heredoc(s) in ${rel} contain unescaped backticks ` +
          `(bash will try to execute them as command substitution):\n${preview}`
        );
      }
      expect(offenders).toHaveLength(0);
    });
  }
});

describe('run-agent-orchestration.sh — Step 0.5 assessment prompt specifically', () => {
  const src = readFileSync(join(SCRIPTS_DIR, 'run-agent-orchestration.sh'), 'utf8');

  it('assessment_prompt heredoc is unquoted (uses PROMPT_HEADER without quotes, needed for ${phase_id} expansion)', () => {
    expect(src).toMatch(/assessment_prompt=\$\(cat << PROMPT_HEADER/);
  });

  it('the API-key-example CRITICAL RULE line has all three backticks escaped', () => {
    const idx = src.indexOf('NEVER write example API keys');
    expect(idx).toBeGreaterThan(-1);
    const line = src.slice(idx, src.indexOf('\n', idx));
    const backtickCount = (line.match(/`/g) || []).length;
    const escapedCount = (line.match(/\\`/g) || []).length;
    expect(backtickCount).toBeGreaterThan(0);
    expect(escapedCount).toBe(backtickCount);
  });

  it('${phase_id} and ${PRD_REL} still expand correctly (heredoc is not fully quoted)', () => {
    const promptIdx = src.indexOf('assessment_prompt=$(cat << PROMPT_HEADER');
    const endIdx = src.indexOf('\nPROMPT_HEADER', promptIdx);
    const body = src.slice(promptIdx, endIdx);
    expect(body).toMatch(/\$\{phase_id\}/);
    expect(body).toMatch(/\$\{PRD_REL\}/);
  });
});
