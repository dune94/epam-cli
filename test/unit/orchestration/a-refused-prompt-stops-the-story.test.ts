/**
 * A PROMPT THE BUILDER REFUSED TO BUILD MUST NOT BE SENT ANYWAY.
 *
 * WRITTEN BEFORE THE FIX. FOUND IN A PRE-LAUNCH REVIEW, 2026-08-13.
 *
 * build_implementation_prompt refuses in four places, each for a reason someone thought
 * important enough to abandon the prompt over: the test-ownership policy failed to render, the
 * declared inputs failed to render, the file-injection budget could not be resolved.
 *
 * Every one of those refusals is SWALLOWED at the call site:
 *
 *     prompt="$(build_implementation_prompt "$story_id")
 *     $(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
 *
 * A variable assignment takes its exit status from the LAST command substitution it evaluated —
 * here, build_kb_prompt_section, which succeeds. So `set -e` never fires, the `return 1` is lost,
 * and `prompt` becomes the empty first line plus the KB section.
 *
 * The writer is then invoked with a prompt that has no story, no acceptance criteria, no
 * verification criteria, no file list and no plan — just knowledge-base entries. It will produce
 * SOMETHING, that something will be committed, and the run will look ordinary. This is the worst
 * failure shape this pipeline has: not a crash, a confident blank.
 *
 * Proven in isolation:
 *     set -e; f(){ return 1; }; g(){ printf 'KB'; }; p="$(f)\n$(g)"; echo "rc=$? p=[$p]"
 *     → rc=0 p=[\nKB]
 *
 * This predates the declared-inputs work — the test-ownership refusal has never stopped anything
 * either — but that work adds refusals, so it must be fixed before a run, not after.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');


/**
 * The REAL statement claude.sh uses to assemble the writer prompt, lifted rather than paraphrased
 * so this test tracks whatever the script actually does. It spans from the first builder call to
 * the line that joins both sections.
 */
function promptAssignment(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('_impl_section="$(build_implementation_prompt "$story_id")"');
  expect(start, 'the prompt assembly moved — this test is anchored on it').toBeGreaterThan(0);
  const joinAt = src.indexOf('prompt="$_impl_section', start);
  expect(joinAt, 'the two sections are no longer joined into one prompt').toBeGreaterThan(start);
  const end = src.indexOf('\n', src.indexOf('$_kb_section"', joinAt));
  return src.slice(start, end);
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Run the REAL assignment shape from claude.sh with a refusing builder.
 *
 * The statement is lifted out of the script rather than paraphrased, so this test tracks whatever
 * the script actually does. Both builders are stubbed: the point is the CALLER's handling of a
 * refusal, not what either builder produces.
 */
function runAssignment(): { out: string; rc: number } {
  const statement = promptAssignment();

  const dir = mkdtempSync(join(tmpdir(), 'refused-prompt-')); dirs.push(dir);
  const script = `set -e
story_id=S-1
retry_count=0
next_kb_id=1
error() { printf '%s\\n' "$*" >&2; }
# The builder refuses, exactly as it does when a declared input or the test-ownership policy
# fails to render.
build_implementation_prompt() { error "  [prompt] refusing"; return 1; }
build_kb_prompt_section() { printf 'KB SECTION'; }
${statement}
printf 'REACHED_INVOCATION prompt=[%s]\\n' "$prompt"
`;
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    return { out, rc: 0 };
  } catch (e: any) {
    return { out: (e.stdout || '') + (e.stderr || ''), rc: e.status ?? -1 };
  }
}

describe('A REFUSED BUILD NEVER REACHES THE MODEL', () => {
  it('the story does not continue to invocation with a prompt the builder refused', () => {
    const r = runAssignment();
    expect(r.out, 'the writer was invoked with a prompt the builder had refused to build — it '
      + 'has no story, no criteria and no plan, and the run will look ordinary')
      .not.toContain('REACHED_INVOCATION');
  });

  it('the refusal produces a non-zero status, so a caller can act on it', () => {
    const r = runAssignment();
    expect(r.rc, 'a refused prompt build reported success').not.toBe(0);
  });

  it('the refusal reason still reaches the log', () => {
    // Failing silently would trade one invisible failure for another.
    expect(runAssignment().out).toMatch(/refusing/);
  });
});

describe('A PROMPT THAT DID BUILD IS UNAFFECTED', () => {
  it('both builders succeeding produces the joined prompt and continues', () => {
    // The guard must not turn a working path into a failing one — this is the case that runs on
    // every healthy story.
    const statement = promptAssignment();

    const script = `set -e
story_id=S-1
retry_count=0
next_kb_id=1
error() { printf '%s\\n' "$*" >&2; }
build_implementation_prompt() { printf 'IMPL SECTION'; }
build_kb_prompt_section() { printf 'KB SECTION'; }
${statement}
printf 'REACHED_INVOCATION prompt=[%s]\\n' "$prompt"
`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(out).toContain('REACHED_INVOCATION');
    expect(out).toContain('IMPL SECTION');
    expect(out).toContain('KB SECTION');
  });
});
