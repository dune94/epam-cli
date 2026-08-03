/**
 * Codeline facts, injected DIRECTLY into build_implementation_prompt()'s
 * output — REAL execution of the actual, unmodified bash block, extracted by
 * marker (not re-implemented).
 *
 * Built 2026-08-02: the codeline_facts plugin tool (a real
 * ToolPlugin, see orchestrations/plugins/codeline-context-tools.js) existed
 * and was correct, but across a full Writer Retest run the model called it
 * exactly ZERO times — it called git_state once and never the
 * facts tool that would have told it the right Contentstack token key.
 * Relying on the model to spontaneously discover an optional tool wasn't
 * working. Fix: read .epam/codeline-facts.json deterministically in bash
 * (same PROJECT_ROOT the plugin itself reads) and inject its content
 * directly into the prompt every invocation sees, regardless of whether the
 * model ever calls the tool.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

const FACTS_BLOCK = extractBlock(
  '    # Codeline facts (real, project-operator-curated gotchas',
  '\n    local test_ownership_block=""',
);

// The final heredoc's own conditional injection line, so this test tracks
// the REAL wiring (not just that the variable gets computed) — verified
// present, not re-executed (the full heredoc has too many other
// dependencies to run standalone).
it('the final prompt heredoc actually injects $codeline_facts_block', () => {
  expect(src).toMatch(/\$\(\[ -n "\$codeline_facts_block" \] && printf '%s\\n' "\$codeline_facts_block" \|\| true\)/);
});

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runFactsBlock(projectRoot: string): string {
  const script = `
run_extracted() {
  local PROJECT_ROOT='${projectRoot}'
${FACTS_BLOCK}
  echo "$codeline_facts_block"
}
run_extracted
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'codeline-facts-prompt-'));
  cleanupDirs.push(d);
  return d;
}

describe('codeline-facts prompt injection — real extracted bash', () => {
  it('injects the real facts array as a "## Codeline-Specific Facts" section when .epam/codeline-facts.json exists', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(
      join(repo, '.epam/codeline-facts.json'),
      JSON.stringify({ facts: ['fact one about this codeline', 'fact two about this codeline'] }),
    );
    const out = runFactsBlock(repo);
    expect(out).toContain('## Codeline-Specific Facts');
    expect(out).toContain('fact one about this codeline');
    expect(out).toContain('fact two about this codeline');
  });

  it('supports a bare array shape too (not just {facts: [...]})', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/codeline-facts.json'), JSON.stringify(['bare array fact']));
    const out = runFactsBlock(repo);
    expect(out).toContain('bare array fact');
  });

  it('produces no block at all when .epam/codeline-facts.json does not exist', () => {
    const repo = makeRepo();
    const out = runFactsBlock(repo);
    expect(out.trim()).toBe('');
  });

  it('produces no block when codeline-facts.json is malformed (never crashes the prompt build)', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/codeline-facts.json'), '{ not valid json');
    const out = runFactsBlock(repo);
    expect(out.trim()).toBe('');
  });

  it('produces no block when facts is present but empty', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/codeline-facts.json'), JSON.stringify({ facts: [] }));
    const out = runFactsBlock(repo);
    expect(out.trim()).toBe('');
  });

  it('REPRODUCES the real Metrolinx fact that would have prevented the live regression', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(
      join(repo, '.epam/codeline-facts.json'),
      JSON.stringify({
        facts: [
          'Contentstack Live Preview config uses live_preview: { enable, preview_token } — preview_token, NOT management_token.',
        ],
      }),
    );
    const out = runFactsBlock(repo);
    expect(out).toContain('preview_token');
    expect(out).toContain('NOT management_token');
  });
});
