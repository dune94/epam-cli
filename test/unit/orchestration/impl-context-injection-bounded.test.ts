/**
 * Impl-prompt context must be BOUNDED to the fix-site file(s) (found live 2026-07-24,
 * AMSD-1820): the injection loop dumped FULL content (up to 400 lines) for EVERY file in
 * technicalNotes.files (5 files) → the impl prompt ballooned to 137-189K input tokens, and
 * the agent exhausted its output budget on exploration ("Now let me explore...") and NEVER
 * called WriteFile → 0 files changed → deliverable gate failed → 8 retries → run dead.
 *
 * The detective already pinpoints the ONE causal fix-site file (fixSiteAnalysis). Inject
 * FULL content only for fix-site file(s); list the other declared files as paths (the agent
 * ReadFiles them only if needed). Falls back to all files when there is no fixSiteAnalysis.
 *
 * Drives the REAL bash injection block extracted from claude.sh against a temp repo.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Extract the injection block: from `local existing_file_contents=""` to the loop's `done`.
function extractInjectionBlock(): string {
  const start = CLAUDE_SH.indexOf('local existing_file_contents=""');
  const endAnchor = ".technicalNotes.files[]? // empty')";
  const end = CLAUDE_SH.indexOf(endAnchor, start);
  if (start === -1 || end === -1) throw new Error('injection block markers not found');
  return CLAUDE_SH.slice(start, end + endAnchor.length) + '\n';
}
const block = extractInjectionBlock();

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'impl-inject-'));
  dirs.push(repo);
  // 5 declared files, each with a UNIQUE marker + enough lines to matter
  const files = ['a/fixsite.ts', 'b/other1.ts', 'c/other2.ts', 'd/other3.ts', 'e/other4.ts'];
  for (const f of files) {
    mkdirSync(join(repo, dirname(f)), { recursive: true });
    writeFileSync(join(repo, f), `// MARKER_${f.replace(/[^a-z0-9]/gi, '_')}\n` + 'const x = 1;\n'.repeat(50));
  }
  return repo;
}

// Run the extracted block with a story_json; return the resulting $existing_file_contents.
function runInjection(repo: string, files: string[], fixSites: string[]): string {
  const storyJson = JSON.stringify({ technicalNotes: { files }, fixSiteAnalysis: fixSites.map((f) => ({ file: f })) });
  const script = `
run_it() {
  local PROJECT_ROOT='${repo}'
  local story_json='${storyJson}'
  # Config accessors claude.sh gained after this harness was written. Unstubbed the block
  # aborts, and the assertion fails during SETUP instead of on the bound being tested.
  existing_file_max_lines(){ echo 400; }
  existing_file_injection_enabled(){ return 0; }
  _resolve_deliverable_path(){ echo "$1"; }
${block}
  printf '%s' "$existing_file_contents"
}
export EPAM_BROWNFIELD=1
run_it
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('impl-prompt injection is bounded to the fix-site file(s)', () => {
  const FILES = ['a/fixsite.ts', 'b/other1.ts', 'c/other2.ts', 'd/other3.ts', 'e/other4.ts'];

  it('injects FULL content only for the fix-site file, not all 5 declared files', () => {
    const out = runInjection(repo(), FILES, ['a/fixsite.ts']);
    expect(out).toContain('MARKER_a_fixsite_ts');       // fix-site content present
    expect(out).not.toContain('MARKER_b_other1_ts');    // other files' content NOT dumped
    expect(out).not.toContain('MARKER_c_other2_ts');
    expect(out).not.toContain('MARKER_e_other4_ts');
  });

  it('with NO fixSiteAnalysis, falls back to injecting all files (unchanged behavior)', () => {
    const out = runInjection(repo(), FILES, []);
    expect(out).toContain('MARKER_a_fixsite_ts');
    expect(out).toContain('MARKER_b_other1_ts');
  });

  let _repo: string | null = null;
  function repo() { if (!_repo) _repo = makeRepo(); return _repo; }
});
