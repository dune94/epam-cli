/**
 * A GATE THAT SKIPS WHAT IT CANNOT RECOGNISE IS A GATE THAT PASSES EVERYTHING ELSE.
 *
 * The verification plugin replaced sixteen hardcoded compiler invocations, and every gate now
 * calls _run_project_verification, which runs the command the PROJECT declares. That migration
 * was reported complete. It was complete for the INVOCATION and untouched for the PRECONDITION:
 *
 *     _ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" | grep -v node_modules | wc -l)
 *     [ "$_ts_count" -eq 0 ] && return 0            # ← 0 means PASS
 *     [ ! -f "$PROJECT_ROOT/tsconfig.json" ] && return 0
 *
 * So the engine stopped naming a compiler and kept naming the ecosystem, in the one place where
 * the answer is "skip" — which the callers read as "passed". Point any gate at a repository with
 * no `src/*.ts` and it reports success without verifying anything. That is the exact defect the
 * plugin exists to prevent, moved from the call to the condition.
 *
 * The precondition is also REDUNDANT. runVerification() already distinguishes three states, and
 * the undeclared one is not a pass: a project with no manifest returns UNKNOWN, and every caller
 * treats a non-zero exit as a failure. Deleting the precondition therefore removes a fail-open
 * path without weakening anything — the project's own declaration decides, as intended.
 *
 * THIS IS A SWEEP over every gate, because the same three lines were copy-pasted into three of
 * them and a fourth would be added the same way. It fails on any gate that decides whether to
 * verify by looking for a language's files.
 *
 * Written BEFORE the removal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

/** Engine scripts only. Scaffold generators legitimately WRITE a stack's files. */
function engineScripts(): Array<{ file: string; lines: string[] }> {
  const files: string[] = [];
  for (const f of readdirSync(SCRIPTS)) {
    if (!f.endsWith('.sh')) continue;
    if (f.startsWith('scaffold-')) continue;   // generates a project; naming its stack is the job
    if (f.startsWith('mock')) continue;        // builds a fixture repo
    files.push(join(SCRIPTS, f));
  }
  for (const f of readdirSync(join(SCRIPTS, 'lib'))) {
    if (f.endsWith('.sh')) files.push(join(SCRIPTS, 'lib', f));
  }
  return files.map((file) => ({ file: file.replace(ROOT, ''), lines: readFileSync(file, 'utf8').split('\n') }));
}

/** Lines that decide whether to verify by counting a language's source files. */
function stackPreconditions(): string[] {
  const out: string[] = [];
  for (const { file, lines } of engineScripts()) {
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('#')) return;
      // The write perimeter walks source files to chmod them. That is a permission operation,
      // not a decision about whether to verify — a real and separate stack-hardcoding finding,
      // scoped out of this sweep so the two are fixed independently rather than together.
      if (/chmod/.test(l)) return;
      if (/-exec\s+chmod/.test(l)) return;
      // `done < <(find ...)` feeds a loop; the chmod is on the body line above, so the feeder
      // itself carries no chmod to match. Still the perimeter, still not a gate condition.
      if (/^done\s*<\s*<\(find/.test(t)) return;
      // "does this repo contain files of language X" used as a gate condition
      if (/find\s+"?\$\{?PROJECT_ROOT\}?\/src"?\s+-name\s+"\*\.[a-z]+"/.test(l)) {
        out.push(`${file}:${i + 1}  ${t.slice(0, 95)}`);
      }
      // "does this repo have tool X's config" used as a gate condition
      if (/\[\s*!\s*-f\s+"?\$\{?PROJECT_ROOT\}?\/(tsconfig|jsconfig|pyproject|go)\./.test(l)) {
        out.push(`${file}:${i + 1}  ${t.slice(0, 95)}`);
      }
    });
  }
  return out;
}

describe('the sweep can see a real precondition — otherwise it passes vacuously', () => {
  it('its own patterns match the known-bad shapes', () => {
    expect(/find\s+"?\$\{?PROJECT_ROOT\}?\/src"?\s+-name\s+"\*\.[a-z]+"/
      .test('_ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | wc -l)')).toBe(true);
    expect(/\[\s*!\s*-f\s+"?\$\{?PROJECT_ROOT\}?\/(tsconfig|jsconfig|pyproject|go)\./
      .test('[ ! -f "$PROJECT_ROOT/tsconfig.json" ] && return 0')).toBe(true);
  });

  it('there are engine scripts to scan', () => {
    expect(engineScripts().length).toBeGreaterThan(5);
  });
});

describe('THE DEFECT CLASS: no gate decides whether to verify by looking for a language', () => {
  it('verification is gated by the project declaration, not by file extensions', () => {
    expect(
      stackPreconditions(),
      'these skip verification when a language\'s files are absent, and callers read skip as ' +
      'PASS. runVerification already reports UNKNOWN for an undeclared project and every caller ' +
      'treats non-zero as failure, so the project\'s own declaration is the only condition needed',
    ).toEqual([]);
  });
});

describe('the gates still call the plugin', () => {
  it('every gate that verifies goes through the shared helper', () => {
    const users = engineScripts()
      .filter(({ lines }) => lines.some((l) => l.includes('_run_project_verification')))
      .map(({ file }) => file);
    for (const expected of ['claude.sh', 'run-agent-orchestration.sh', 'lib/story-guards.sh']) {
      expect(
        users.some((u) => u.endsWith(expected)),
        `${expected} no longer routes verification through the helper — did the gate get dropped ` +
        'rather than migrated?',
      ).toBe(true);
    }
  });
});
