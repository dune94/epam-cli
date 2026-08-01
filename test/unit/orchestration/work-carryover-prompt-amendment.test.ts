/**
 * The work-carryover prompt-amendment block in implement_story() (added
 * 2026-08-01): turns LAST_VERIFIED_TOUCHED_FILES / LAST_VERIFIED_UNCHANGED_FILES
 * (set by verify_story_deliverables — see verify-story-deliverables-work-
 * carryover.test.ts) into explicit guidance appended to COORDINATOR_PROMPT_AMENDMENT
 * for the next retry, instead of leaving the distinction to be re-derived from
 * "## Existing File Contents" prose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractBlock(): string {
  const start = claudeSrc.indexOf('# Work carryover: verify_story_deliverables');
  const marker = 'COORDINATOR_PROMPT_AMENDMENT="${COORDINATOR_PROMPT_AMENDMENT:-}${_carryover_note}"\n            fi\n';
  const end = claudeSrc.indexOf(marker, start) + marker.length;
  return claudeSrc.slice(start, end);
}

const BLOCK = extractBlock();

function run(touched: string, unchanged: string, existingAmendment = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'carryover-amendment-'));
  try {
    const scriptPath = join(dir, 'run.sh');
    // $'...' (ANSI-C quoting) so bash itself interprets \n as a real newline —
    // plain "..." double-quotes leave \n as a literal backslash+n in bash.
    const ansiC = (s: string) => `$'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
    const script = `
LAST_VERIFIED_TOUCHED_FILES=${ansiC(touched)}
LAST_VERIFIED_UNCHANGED_FILES=${ansiC(unchanged)}
COORDINATOR_PROMPT_AMENDMENT=${ansiC(existingAmendment)}
apply() {
${BLOCK}
}
apply
printf '%s' "$COORDINATOR_PROMPT_AMENDMENT"
`;
    writeFileSync(scriptPath, script);
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('work-carryover prompt amendment', () => {
  it('does nothing when neither global is set', () => {
    expect(run('', '')).toBe('');
  });

  it('lists touched files as "build on them, do not rewrite"', () => {
    const out = run('src/a.ts\nsrc/b.ts', '');
    expect(out).toContain('## Work Already Done');
    expect(out).toContain('build on them, do NOT rewrite from scratch');
    expect(out).toContain('- src/a.ts');
    expect(out).toContain('- src/b.ts');
  });

  it('lists unchanged files as "still needs it"', () => {
    const out = run('', 'src/c.ts');
    expect(out).toContain('still show NO changes since baseline');
    expect(out).toContain('- src/c.ts');
  });

  it('includes both sections when there is a real mix', () => {
    const out = run('src/a.ts', 'src/c.ts');
    expect(out).toContain('- src/a.ts');
    expect(out).toContain('- src/c.ts');
    expect(out.indexOf('Already Done')).toBeLessThan(out.indexOf('- src/a.ts'));
  });

  it('appends to an existing amendment (e.g. from classify_failure_class) rather than overwriting it', () => {
    const out = run('src/a.ts', '', 'CRITICAL: previous attempt exhausted iterations.');
    expect(out).toContain('CRITICAL: previous attempt exhausted iterations.');
    expect(out).toContain('- src/a.ts');
    expect(out.indexOf('CRITICAL')).toBeLessThan(out.indexOf('- src/a.ts'));
  });
});
