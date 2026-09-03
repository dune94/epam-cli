/**
 * A HANDLER'S OUTPUT MUST SURVIVE A PIPE.
 *
 * process.stdout is SYNCHRONOUS to a file and ASYNCHRONOUS to a pipe. A handler that writes a large
 * result and then calls process.exit() tears the process down before the pipe buffer drains, and
 * the output is silently cut at the buffer boundary. No error, no exit code, no warning — just less
 * data than was written.
 *
 * Every caller in this pipeline reads handlers through `$( ... )` command substitution, which is a
 * pipe. So the truncation applies to the real call path, and only to the real call path: the same
 * command redirected to a file is complete, which is what makes it so hard to see.
 *
 * MEASURED 2026-09-02, testable-source.js against next.gotransit.com (3,261 tracked files, ~120 KB
 * of output):
 *
 *   > file          3,070 lines   complete
 *   | pipe          1,036 lines
 *   $( ... )        1,037 lines   <- what brownfield-repro-test-writer.sh actually does
 *
 * The consequence: the truncated set keeps only the shallow paths, every deeply-nested file
 * disappears, and _is_testable_source() answers "no" for a file that genuinely IS testable. The
 * stage then reports "no testable source file in the change — nothing to test", which reads exactly
 * like a correct decision. AMSD-1919 shipped a correct one-line fix with no test because of this.
 *
 * WHY IT SURVIVED: mock3, which every rehearsal uses, has 1,620 files — its output fits inside the
 * pipe buffer. The defect only appears on a repository large enough to overflow it, and it is
 * present and byte-identical at the v1.5 tag.
 *
 * THE RULE: a handler sets process.exitCode and lets the process end naturally, so stdout drains.
 * `process.exit()` is only safe when nothing has been written.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const HANDLER_DIR = join(REPO, 'orchestrations/scripts/lib/handlers');
const TESTABLE = join(HANDLER_DIR, 'testable-source.js');
const NODE = process.execPath;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/** A codeline whose testable set is far larger than a pipe buffer (64 KB on Linux). */
function bigCodeline(n = 3000) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-trunc-')); dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    // Long, deep paths — the real shape, and what makes the output exceed the buffer.
    const d = `src/components/features/area${i % 30}/sub${i % 15}/deeply/nested/module${i % 7}`;
    mkdirSync(join(root, d), { recursive: true });
    const rel = `${d}/ComponentImplementation${i}.tsx`;
    writeFileSync(join(root, rel), 'export const C = () => null;\n');
    paths.push(rel);
  }
  return { root, paths };
}

describe('a handler must not truncate into a pipe', () => {
  const { root, paths } = bigCodeline();

  it('the fixture produces more output than a pipe buffer holds', () => {
    // Non-vacuity: below the buffer size the defect cannot appear and every assertion is empty.
    const bytes = paths.join('\n').length;
    expect(bytes, `fixture output is only ${bytes} bytes — too small to exercise the boundary`)
      .toBeGreaterThan(65536);
  });

  it('TESTABLE-SOURCE: a pipe returns the same as a file', () => {
    // execFileSync, not a shell string: 3,000 long paths on a command line is E2BIG, which is a
    // limit of MY test rather than of the handler. The pipe/file distinction is what is under test.
    const toFile = join(root, 'out.txt');
    const fd = openSync(toFile, 'w');
    execFileSync(NODE, [TESTABLE, root, ...paths], { stdio: ['ignore', fd, 'ignore'], maxBuffer: 1e9 });
    closeSync(fd);
    const fileLines = readFileSync(toFile, 'utf8').split('\n').filter(Boolean).length;

    // 'pipe' is exactly what $( ... ) gives the handler.
    const piped = execFileSync(NODE, [TESTABLE, root, ...paths],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e9 })
      .split('\n').filter(Boolean).length;

    expect(fileLines, 'the handler produced nothing to a file — the fixture did not exercise it')
      .toBeGreaterThan(2000);
    expect(piped,
      `piping lost output: ${piped} lines through a pipe against ${fileLines} to a file. Every `
      + 'caller reads this handler through $( ... ), which is a pipe, so the pipeline sees the '
      + 'short answer and treats it as the truth.')
      .toBe(fileLines);
  });

  it('THIS handler lets stdout drain before the process ends', () => {
    // SCOPED DELIBERATELY TO THE PROVEN CASE. Twenty-four handlers share the shape
    // `process.exit(main())` after writing, but only this one is demonstrated to truncate on a real
    // codeline, and only this one blocks the story in hand. Rewriting all twenty-four to satisfy a
    // harness would be a pipeline-wide change justified by a single measurement — the over-reach
    // that has caused more damage here than the defects. The others are a separate, evidence-led
    // decision: each needs its own proof that its output can exceed a pipe buffer.
    const src = readFileSync(TESTABLE, 'utf8');
    expect(src,
      'testable-source.js still calls process.exit() after writing its result, so every caller '
      + 'reading it through $( ... ) gets a silently truncated set')
      .not.toMatch(/process\.exit\(\s*main\(\)\s*\)/);
  });
});
