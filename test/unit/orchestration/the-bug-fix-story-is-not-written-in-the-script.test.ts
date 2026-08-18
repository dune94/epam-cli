/**
 * WHEN TESTS FAIL, THE PIPELINE SYNTHESISES A STORY TO FIX THEM — AND THAT STORY'S DESCRIPTION IS A
 * PROMPT.
 *
 * The writer agent that picks the bug-fix story up reads `.description` as its instructions. That
 * text was a shell string literal in run-agent-orchestration.sh Step 3.08, so a prompt was living in
 * a 10,000-line script where no prompt review would ever reach it.
 *
 * It also said "vitest". On any codeline that is not Node, the pipeline was telling its own writer
 * to fix "the failing vitest tests" in a repository that has never run vitest. And `agentRole` was
 * the literal "typescript-engineer" — one of epam-cli's OWN roles — so every bug-fix story on every
 * client project was assigned to an agent that project never minted.
 *
 * These execute the template and assert on the rendered text, not on the source.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const ENGINE = join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js');

/** Render a body of the bug-fix template exactly as the shell does. */
function render(bodyKey: string, values: Record<string, string>): string {
  const r = spawnSync(process.execPath, ['-e',
    'const {renderEngineTemplate}=require(process.argv[1]);' +
    'process.stdout.write(renderEngineTemplate(process.argv[2],JSON.parse(process.argv[4]),process.argv[3]));',
    ENGINE, 'bug-fix-story', bodyKey, JSON.stringify(values),
  ], { encoding: 'utf8' });
  expect(r.status, `the template did not render: ${r.stderr}`).toBe(0);
  expect(r.stdout.length, 'the template rendered nothing — every assertion below would be vacuous')
    .toBeGreaterThan(20);
  return r.stdout;
}

const VALUES = {
  __FAILING_FILE__: 'src/fare/calc_test.rs',
  __TEST_COMMAND__: 'cargo test',
  __FAILING_TESTS__: 'test fare::zone_boundary ... FAILED',
};

describe('the bug-fix story is not written in the script', () => {
  it('carries the codeline’s own test command, not a runner the engine picked', () => {
    const body = render('prompt', VALUES);
    expect(body, 'the rendered instructions do not name the codeline’s test command')
      .toContain('cargo test');
    expect(body.toLowerCase(), 'the engine named a JavaScript test runner to a Rust codeline')
      .not.toContain('vitest');
  });

  it('bounds the writer to a minimum change and forbids passing by deletion', () => {
    // The whole reason this story exists. Without the bound, a writer handed a failing file
    // rewrites it, discards the original story's work, and goes green by removing the test.
    const body = render('prompt', VALUES);
    expect(body).toMatch(/minimum change/i);
    expect(body, 'nothing stops the writer from deleting the failing test').toMatch(/delet/i);
  });

  it('names the failing file in both the title and the instructions', () => {
    expect(render('title', { __FAILING_FILE__: VALUES.__FAILING_FILE__ })).toContain('src/fare/calc_test.rs');
    expect(render('prompt', VALUES)).toContain('src/fare/calc_test.rs');
  });

  it('the script no longer holds the story text or a test runner’s name', () => {
    const src = readFileSync(ORCH, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // comments record the removal
    expect(src, 'the bug-fix description is still a literal in the script')
      .not.toContain('Fix the failing vitest tests');
    expect(src, 'the bug-fix title is still a literal in the script')
      .not.toContain('Bug fix: failing tests in ${failing_file}');
  });

  it('assigns no role the engine invented', () => {
    // typescript-engineer is epam-cli's own role. A client project never minted it, so the story
    // was assigned to an agent that does not exist there.
    const src = readFileSync(ORCH, 'utf8')
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => !/^\s*#/.test(l) && l.includes('typescript-engineer'));
    expect(src.map(([n, l]) => `${n}: ${l.trim()}`),
      'a role name is still hardcoded in the generic pipeline',
    ).toEqual([]);
  });

  it('refuses a value it was not given rather than rendering a hole', () => {
    const r = spawnSync(process.execPath, ['-e',
      'const {renderEngineTemplate}=require(process.argv[1]);' +
      'renderEngineTemplate("bug-fix-story",{__FAILING_FILE__:"a"},"prompt");',
      ENGINE,
    ], { encoding: 'utf8' });
    expect(r.status, 'a story rendered with missing values would reach the writer as a hole')
      .not.toBe(0);
  });
});
