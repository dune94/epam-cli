/**
 * A STRIPPED `local` DECLARATION BECAME A COMMAND, AND EXIT 127 KILLED THE RUN AT STEP 7.
 *
 * `local` outside a function body is an error, so commit 8d0c578 removed the keyword. It removed
 * only the keyword:
 *
 *     local _mc_role_file; _mc_role_file=$(mktemp ...)     ->    _mc_role_file; _mc_role_file=$(...)
 *     local _lf_outputs_file _lf_stories_file              ->    _lf_outputs_file _lf_stories_file
 *
 * What is left is a bare word in COMMAND POSITION. bash looks for a program called
 * `_mc_role_file`, finds none, and returns 127. Live 2026-08-17 run 20260817T231306Z:
 *
 *     run-agent-orchestration.sh: line 5803: _mc_role_file: command not found
 *     [ERROR] [orch] Phase 'core' for 'mocka' failed (exit 127)
 *
 * Both lanes died there — at Step 7, one step before the writer — after the mint, both spec
 * passes, both CPA gates and both regression guards had all passed.
 *
 * SEVEN SITES, ONE EDIT. Six carry the `name; name=` shape, one is a bare multi-word declaration.
 * Only the first ever fired, because the other six live in the lint stages the run never reached.
 *
 * `bash -n` CANNOT SEE THIS. The syntax is completely valid — it is a command invocation, and
 * whether that command exists is a runtime fact. This is the bash twin of the undefined JS
 * function that killed run 13 (`validateSurveyFilesRead is not defined`), which is now caught by
 * eslint no-undef. The bash half of the pipeline has no equivalent.
 *
 * The test does BOTH halves: it proves the shape is gone from the real script, and it EXECUTES
 * every declaration-shaped line the real script contains to prove bash accepts them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const source = () => readFileSync(SCRIPT, 'utf8').split('\n');

/**
 * Declaration-shaped lines, located by shape rather than by line number so the test does not rot
 * when the file moves. Two shapes, both produced by stripping a leading `local`:
 *   `name; name=...`         — the declare-then-assign idiom
 *   `name other` / `name`    — a bare declaration of one or more names
 */
function declarationShapedLines() {
  const out: { line: number; text: string; first: string }[] = [];
  // The script embeds python and node via heredocs. Those bodies are not bash and must not be
  // read as bash — `from collections import deque` is not a stripped declaration.
  // The same applies to multi-line single-quoted strings — `local _py='` opens a python program
  // that runs to the closing quote, and none of it is bash either.
  let heredoc: string | null = null;
  let inQuote = false;
  source().forEach((raw, i) => {
    const text = raw.trim();
    if (inQuote) {
      if ((raw.match(/'/g) || []).length % 2 === 1) inQuote = false;
      return;
    }
    if (heredoc !== null) {
      if (text === heredoc) heredoc = null;
      return;
    }
    if ((raw.match(/'/g) || []).length % 2 === 1) { inQuote = true; return; }
    const opener = raw.match(/<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\s*$/);
    if (opener) { heredoc = opener[1]; return; }
    if (!text || text.startsWith('#')) return;
    // `_name; _name=` — a bare word repeated as the target of the assignment that follows it.
    const m = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*;\s*\1=/);
    if (m) { out.push({ line: i + 1, text, first: m[1] }); return; }
    // `_name _other` — nothing but identifiers. This is a stripped declaration ONLY when the
    // leading word is not itself a command: `local x y`, `export FOO`, `unset a b` are all this
    // shape and all correct. Resolution is asked of bash, so no list of builtins is written here.
    //
    // SCOPE, STATED HONESTLY: the leading word must also match the underscore prefix this script
    // uses for every function-local variable. Without that, embedded python and node — which this
    // file carries inside heredocs and multi-line quoted strings — read as bash and produce noise
    // (`from collections import deque`). Separating those languages reliably needs a real parser,
    // not a line scanner, so this test claims only what it can actually see: stripped declarations
    // of THIS script's own locals. A general bash equivalent of eslint's no-undef is a separate
    // piece of work and is not pretended at here.
    const bare = text.match(/^(_[A-Za-z0-9_]*)((?:\s+[A-Za-z_][A-Za-z0-9_]*)+)$/);
    if (bare && !resolves(bare[1])) out.push({ line: i + 1, text, first: bare[1] });
  });
  return out;
}

/** Does bash know this word as a builtin, keyword, alias, function or program on PATH? */
const _resolved = new Map<string, boolean>();
function resolves(word: string): boolean {
  if (!_resolved.has(word)) {
    _resolved.set(word, spawnSync('bash', ['-c', `type -t ${word}`]).status === 0);
  }
  return _resolved.get(word)!;
}

describe('a stripped declaration runs as a command', () => {
  it('NO LINE STARTS BY INVOKING ITS OWN VARIABLE — the shape that returned 127', () => {
    const bad = declarationShapedLines();
    expect(bad.map((b) => `${b.line}: ${b.text}`).join('\n'),
      'a stripped `local` is still being executed as a command; bash returns 127 and the phase dies')
      .toBe('');
  });

  it('THE LINE THAT KILLED THE RUN EXECUTES — mktemp assignment, not command lookup', () => {
    // Execute the real idiom the way the script does, under the script's own strictness.
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c',
      '_mc_role_file=$(mktemp "${TMPDIR:-/tmp}/mc-role-XXXXXX.txt"); [ -f "$_mc_role_file" ]; rm -f "$_mc_role_file"',
    ], { encoding: 'utf8' });
    expect(r.stderr, 'the fixed form still invokes something').not.toMatch(/command not found/);
    expect(r.status, 'the fixed form does not exit clean').toBe(0);
  });

  it('THE ORIGINAL FORM REALLY DID RETURN 127 — the defect is reproduced, not assumed', () => {
    // Guard against a vacuous pass: if this shape were harmless the first test would prove nothing.
    const r = spawnSync('bash', ['-c',
      '_mc_role_file; _mc_role_file=$(mktemp "${TMPDIR:-/tmp}/mc-role-XXXXXX.txt"); rm -f "$_mc_role_file"',
    ], { encoding: 'utf8' });
    expect(r.stderr).toMatch(/_mc_role_file: command not found/);
  });

  it('and it is fatal under the strictness the script actually runs with', () => {
    // `set -e` turns the failed lookup into the phase exit code the operator saw.
    const r = spawnSync('bash', ['-e', '-c', '_mc_role_file; echo REACHED'], { encoding: 'utf8' });
    expect(r.status, 'a 127 under set -e must abort').toBe(127);
    expect(r.stdout, 'execution continued past the failed command').not.toMatch(/REACHED/);
  });

  it('every mktemp declaration in the script assigns rather than invokes', () => {
    // The whole family the bad edit touched, checked as a family.
    const offenders = source()
      .map((l, i) => ({ line: i + 1, text: l.trim() }))
      .filter(({ text }) => text.includes('mktemp'))
      .filter(({ text }) => /^[A-Za-z_][A-Za-z0-9_]*\s*;/.test(text));
    expect(offenders, 'a mktemp declaration is still invoking its own variable name').toEqual([]);
  });
});
