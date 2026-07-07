/**
 * Prompt-size scratchpad summarization (2026-07-07).
 *
 * Root cause found while investigating SKY-002-test/SKY-003-test watchdog
 * timeouts: COORDINATOR_PROMPT_AMENDMENT PREPENDS a new "## Self-Heal: Failure
 * Analyst Summary" block onto itself every retry (`COORDINATOR_PROMPT_AMENDMENT=
 * "${_existing}\n## Self-Heal: Failure Analyst Summary\n${_analyst_guidance}"`)
 * without ever dropping older blocks — by a story's 4th-5th internal attempt,
 * the cumulative prompt is measurably bigger than attempt 1's. A live process
 * inspection during a real timeout confirmed a genuinely in-flight,
 * still-ESTABLISHED API connection (not a stuck/crashed process) — bigger
 * prompts can legitimately take longer to answer, eventually outrunning the
 * watchdog budget.
 *
 * Fix: once the assembled prompt exceeds EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS
 * (default 16000), the full prompt is persisted to a scratchpad file for
 * audit/debugging, and the in-prompt coordinator guidance is trimmed down to
 * only the MOST RECENT "## "-headed section — the model still sees the latest,
 * most relevant guidance, it just isn't re-reading every prior attempt's
 * guidance on every single retry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('claude.sh — prompt scratchpad summarization (source inspection)', () => {
  it('writes the full prompt to LOG_DIR/kb-scratchpad before trimming', () => {
    expect(claudeSrc).toMatch(/_scratchpad_dir="\$\{LOG_DIR\}\/kb-scratchpad"/);
    expect(claudeSrc).toMatch(/printf '%s' "\$prompt" > "\$_scratchpad_file"/);
  });

  it('threshold is configurable via EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS and opt-outable via 0', () => {
    expect(claudeSrc).toMatch(/EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS:-16000/);
    expect(claudeSrc).toMatch(/_scratchpad_threshold" -gt 0/);
  });

  it('trims COORDINATOR_PROMPT_AMENDMENT down to only the last "## "-headed section', () => {
    const idx = claudeSrc.indexOf('_trimmed_amendment=$(printf');
    expect(idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(idx, idx + 400);
    expect(block).toMatch(/heading_idxs = \[i for i, l in enumerate\(lines\) if l\.startswith\('## '\)\]/);
    expect(block).toMatch(/heading_idxs\[-1\]/);
  });
});

/**
 * Extracts the exact python inline extraction logic from claude.sh so this test
 * exercises the REAL trimming code, not a reimplementation. Isolated via
 * boundary markers rather than brace-counting since it's an inline command
 * substitution, not a standalone bash function.
 */
function extractTrimmerPython(): string {
  const startMarker = "_trimmed_amendment=$(printf '%s' \"$COORDINATOR_PROMPT_AMENDMENT\" | python3 -c \"";
  const start = claudeSrc.indexOf(startMarker);
  if (start === -1) throw new Error('trimmer start marker not found');
  const bodyStart = start + startMarker.length;
  const end = claudeSrc.indexOf('\n" 2>/dev/null', bodyStart);
  if (end === -1) throw new Error('trimmer end marker not found');
  return claudeSrc.slice(bodyStart, end).replace(/\\"/g, '"');
}

function runTrimmer(input: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'trimmer-test-'));
  try {
    const scriptPath = join(dir, 'trim.py');
    writeFileSync(scriptPath, extractTrimmerPython());
    return execFileSync('python3', [scriptPath], { input, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('coordinator-guidance trimmer — REAL execution', () => {
  it('keeps only the most recent "## "-headed section when multiple are stacked', () => {
    const stacked = `
## Self-Heal: Failure Analyst Summary
Root cause: wrong import path.
## Self-Heal: Failure Analyst Summary
Root cause: incomplete mock factory.
## Self-Heal: Failure Analyst Summary
Root cause: missing test params.`;
    const trimmed = runTrimmer(stacked);
    expect(trimmed).toContain('missing test params');
    expect(trimmed).not.toContain('wrong import path');
    expect(trimmed).not.toContain('incomplete mock factory');
  });

  it('returns the text unchanged when there is only one heading', () => {
    const single = `
## Self-Heal: Failure Analyst Summary
Root cause: wrong import path.`;
    const trimmed = runTrimmer(single);
    expect(trimmed.trim()).toBe(single.trim());
  });

  it('returns the text unchanged when there are no "## " headings at all', () => {
    const plain = 'Just some plain guidance text with no headings.';
    const trimmed = runTrimmer(plain);
    expect(trimmed.trim()).toBe(plain.trim());
  });
});

describe('claude.sh retry-loop — full prompt-scratchpad integration (REAL execution)', () => {
  function extractPromptScratchpadBlock(): string {
    const start = claudeSrc.indexOf('# Prompt-size scratchpad summarization');
    const end = claudeSrc.indexOf('\n        fi\n\n        # Log the prompt', start);
    if (start === -1 || end === -1) throw new Error('scratchpad block markers not found');
    return claudeSrc.slice(start, end + '\n        fi'.length);
  }

  function run(opts: { promptBase: string; amendment: string; threshold?: string }): {
    scratchpadFiles: string[];
    finalPromptContainsFullHistory: boolean;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'scratchpad-integration-'));
    try {
      const block = extractPromptScratchpadBlock();
      mkdirSync(join(dir, 'logs'), { recursive: true });
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `warning() { :; }`,
          `LOG_DIR="${join(dir, 'logs')}"`,
          `build_implementation_prompt() { echo "${opts.promptBase}"; }`,
          `build_kb_prompt_section() { echo ""; }`,
          opts.threshold ? `EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS="${opts.threshold}"` : '',
          // Wrap in a function: the extracted block uses `local`, which bash
          // rejects at top-level scope (matches how this code always runs in
          // the real script — inside implement_story()).
          `run_test() {`,
          `  local story_id="SKY-999"`,
          `  local retry_count=4`,
          `  local next_kb_id="KB-009"`,
          `  local story_plan=""`,
          `  local STORY_GENERATOR_MODE=""`,
          `  local COORDINATOR_PROMPT_AMENDMENT=$'${opts.amendment.replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`,
          `  local prompt="\$(build_implementation_prompt "\$story_id")"`,
          `  prompt="\$prompt

## Coordinator Guidance (retry \${retry_count})
The following targeted instruction was identified from the previous failure:
\${COORDINATOR_PROMPT_AMENDMENT}"`,
          block,
          `  echo "$prompt"`,
          `}`,
          `run_test`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const scratchpadDir = join(dir, 'logs', 'kb-scratchpad');
      let scratchpadFiles: string[] = [];
      try {
        scratchpadFiles = readdirSync(scratchpadDir);
      } catch {
        scratchpadFiles = [];
      }
      return {
        scratchpadFiles,
        finalPromptContainsFullHistory: stdout.includes('EARLIEST GUIDANCE'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('below threshold: no scratchpad file written, full history stays in the prompt', () => {
    const { scratchpadFiles, finalPromptContainsFullHistory } = run({
      promptBase: 'short base prompt',
      amendment: '\n## Self-Heal: Failure Analyst Summary\nEARLIEST GUIDANCE here.',
      threshold: '999999',
    });
    expect(scratchpadFiles).toHaveLength(0);
    expect(finalPromptContainsFullHistory).toBe(true);
  });

  it('above threshold: writes a scratchpad file and trims the prompt to only the most recent guidance', () => {
    const bigBase = 'x'.repeat(20000);
    const { scratchpadFiles, finalPromptContainsFullHistory } = run({
      promptBase: bigBase,
      amendment:
        '\n## Self-Heal: Failure Analyst Summary\nEARLIEST GUIDANCE here.\n## Self-Heal: Failure Analyst Summary\nMOST RECENT GUIDANCE here.',
      threshold: '100',
    });
    expect(scratchpadFiles.length).toBeGreaterThan(0);
    expect(scratchpadFiles[0]).toMatch(/^SKY-999-attempt-5\.md$/);
    expect(finalPromptContainsFullHistory).toBe(false);
  });
});
