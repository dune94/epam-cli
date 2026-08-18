/**
 * THE WRITER AND THE ANALYST MUST BOTH SEE WHAT THE LAST ATTEMPT ACTUALLY DID.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Today the evidence flows to the agents that DECIDE, not to the agent that ACTS:
 *
 *   coordinator  result text, log tail, test-failure output, cross-run history
 *   writer       "what is wrong" only — reviewer blockers, verification failures, prior-run
 *                lessons, and a one-line coordinator amendment distilled from the above
 *   analyst      __VERIFICATION_FAILURE__, ACs, role, dependency contracts, skill addendum
 *
 * NEITHER THE WRITER NOR THE ANALYST IS TOLD WHAT THE ATTEMPT CHANGED. The writer cannot
 * distinguish "I tried X and it was rejected" from "I have not tried anything", so it re-derives
 * an approach it has already been told is wrong. The analyst is asked WHY AN IMPLEMENTATION
 * FAILED while being shown no implementation — live 2026-08-12 it answered "Target=none —
 * Transient import slip; lint message is self-explanatory for retry", a fair reading of the text
 * it had and useless as guidance. Its answer drives model escalation, so a blind diagnosis
 * spends the writer's ladder.
 *
 * ONE SOURCE, TWO CONSUMERS. The summary is computed from git — deterministic, no model, no
 * judgement — and handed to both. Two pipelines is how they drifted into being fed differently
 * in the first place.
 *
 * IT IS NOT SUMMARISED BY AN AGENT. A model between a machine fact and the agent that must act
 * on it destroys provenance and can launder an error into the only version anyone sees — this
 * reviewer approved a change while stating a file was unchanged that had twenty lines added.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const src = () => readFileSync(CLAUDE_SH, 'utf8');

function lift(name: string): string {
  const s = src();
  const start = s.indexOf(`${name}() {`);
  expect(start, `${name} not found in claude.sh`).toBeGreaterThan(0);
  const end = s.indexOf('\n}\n', start) + 3;
  return s.slice(start, end);
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A repo with a committed baseline and some uncommitted work, then the real summary function. */
function summarise(changes: Record<string, string>, baselineRef = 'HEAD'): string {
  const dir = mkdtempSync(join(tmpdir(), 'attempt-summary-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  for (const [f, body] of Object.entries(changes)) writeFileSync(join(dir, f), body);

  return execFileSync('bash', ['-c', `set +e
    PROJECT_ROOT=${JSON.stringify(dir)}
    log() { :; }; info() { :; }; warning() { :; }; error() { :; }; success() { :; }
    engine_paths_filter() { cat; }
${lift('_attempt_change_summary')}
    _attempt_change_summary S1 ${JSON.stringify(baselineRef)}`], { encoding: 'utf8' });
}

describe('THE SUMMARY EXISTS AND IS COMPUTED, NOT ASKED FOR', () => {
  it('claude.sh has a deterministic attempt-summary function', () => {
    expect(() => lift('_attempt_change_summary'),
      'nothing records what an attempt changed').not.toThrow();
  });

  it('no model is involved in producing it', () => {
    // A judgement between a machine fact and the agent acting on it destroys provenance.
    const body = lift('_attempt_change_summary');
    expect(body, 'the summary calls an agent').not.toMatch(/invoke_agent|ai-run\.sh|run_review_prompt/);
  });
});

describe('IT SAYS WHAT CHANGED', () => {
  it('names every file the attempt touched', () => {
    const out = summarise({ 'a.ts': 'export const a = 2;\n', 'c.ts': 'export const c = 3;\n' });
    expect(out, 'a modified file is missing').toContain('a.ts');
    expect(out, 'a new file is missing').toContain('c.ts');
  });

  it('does not claim a file changed when it did not', () => {
    const out = summarise({ 'a.ts': 'export const a = 2;\n' });
    expect(out, 'b.ts was untouched and is reported as changed').not.toContain('b.ts');
  });

  it('carries the SIZE of the change, so "tried nothing" is distinguishable from "tried a lot"', () => {
    // The distinction the writer cannot make today. A 2-line edit and a 400-line rewrite are
    // different situations and produce the same absence of information.
    const out = summarise({ 'a.ts': 'export const a = 2;\n' });
    expect(out).toMatch(/\d/);
  });

  it('an attempt that changed NOTHING says so explicitly', () => {
    // The most important case: an empty summary reads as "no information", and the writer then
    // behaves as though it were the first attempt.
    const out = summarise({});
    expect(out.trim(), 'a no-op attempt produced an empty summary').not.toBe('');
    expect(out).toMatch(/no files|nothing|unchanged/i);
  });
});

describe('BOTH CONSUMERS ARE FED FROM IT', () => {
  const code = () => src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('the WRITER receives it — asserted on the rendered prompt, not on the source', () => {
    // RE-POINTED 2026-08-13, TESTING-FAILURES.md TF-1. This asserted that claude.sh CONTAINS a
    // '## What Your Last Attempt Did' heading. That heading is gone: the diffstat is published as
    // the `attempt-evidence` kind and the writer renders it from its declared inputs, which is
    // what fixed the defect — the old hand-rendered section was gated on a process-local counter
    // and never reached a re-invoked writer.
    //
    // A source match could not tell those two situations apart. The rendered prompt can, and
    // the-writer-is-told-what-it-did-on-every-retry.test.ts asserts exactly that, including the
    // fresh-process case and the engine's own publication. This test keeps the piece that is
    // genuinely about THIS file: the summary is still produced, deterministically, from git.
    expect(code(), 'the diffstat producer is gone').toMatch(/_attempt_change_summary/);
    expect(code(), 'the engine no longer publishes it as an input')
      .toMatch(/publish_agent_output engine attempt-evidence/);
  });
  it('the ANALYST is given it as a value, not left to guess', () => {
    const s = code();
    const i = s.indexOf('__VERIFICATION_FAILURE__');
    expect(i, 'the analyst values block moved').toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, i - 1200), i + 400);
    expect(block, 'the analyst still diagnoses an implementation it cannot see')
      .toMatch(/__ATTEMPT_CHANGES__/);
  });

  it('the analyst PROMPT declares the placeholder, or rendering fails closed', () => {
    // prompt-library throws on an undeclared placeholder and on a missing value, so a template
    // that does not declare it would abort the analyst rather than silently drop the evidence.
    for (const p of ['orchestrations/prompts/templates/failure-analyst.json',
      'orchestrations/projects/metrolinx/prompts/failure-analyst.json']) {
      const doc = JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
      expect(doc.placeholders, `${p} does not declare __ATTEMPT_CHANGES__`)
        .toContain('__ATTEMPT_CHANGES__');
      const body = doc.body || Object.values(doc.bodies || {}).join('\n');
      expect(body, `${p} declares the placeholder but never uses it`)
        .toContain('__ATTEMPT_CHANGES__');
    }
  });
});
