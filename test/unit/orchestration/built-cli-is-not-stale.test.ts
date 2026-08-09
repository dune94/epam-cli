/**
 * THE PIPELINE RUNS dist/, AND EVERY TEST HERE READS src/.
 *
 * Live 2026-08-09. Tool-usage logging was written, unit-tested, committed, and reported as
 * working. The pipeline then ran without emitting a single tool event, because
 * ~/.local/bin/epam is `exec node .../dist/epam.js` and dist was built eighteen hours before
 * the change:
 *
 *     dist/epam.js built  2026-08-08 22:47
 *     src change committed 2026-08-09 16:27
 *     'tool_run' in dist/epam.js: 0
 *
 * Nine tests passed the whole time. They test src/. Nothing in the suite, and nothing in the
 * launcher's pre-flight, compares the artefact the orchestration EXECUTES against the source it
 * was built from — so a source-only fix looks identical to a shipped one from every angle a
 * test can see.
 *
 * This is the third variant of one defect found in a single day: a gate that is never called, a
 * finding that never reaches the writer, and now a fix that never reaches the binary. Each one
 * is correct code that does not run.
 *
 * The check is a staleness comparison, not a build: failing loudly at launch is right, and
 * silently rebuilding under an operator who did not ask for it is not.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const DIST = join(ROOT, 'dist/epam.js');

/** Newest mtime under a directory tree, ignoring anything not compiled into the bundle. */
function newestMtime(dir: string): { path: string; mtime: number } {
  let newest = { path: '', mtime: 0 };
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|js|json)$/.test(e.name)) continue;
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.d.ts')) continue;
      const m = statSync(p).mtimeMs;
      if (m > newest.mtime) newest = { path: p, mtime: m };
    }
  };
  walk(dir);
  return newest;
}

describe('the built CLI is not older than the source it ships', () => {
  it('dist/epam.js exists at all', () => {
    // The `epam` shim is `exec node .../dist/epam.js`. No bundle means every orchestration
    // invocation fails, or silently runs something else entirely.
    expect(existsSync(DIST), 'dist/epam.js is missing — the pipeline has nothing to execute').toBe(true);
  });

  it('it is newer than every source file compiled into it', () => {
    const newest = newestMtime(join(ROOT, 'src'));
    const built = statSync(DIST).mtimeMs;
    expect(
      built,
      `dist/epam.js was built before ${newest.path.replace(ROOT + '/', '')} changed — ` +
      'the pipeline is running an older binary than this suite is testing. Run: ' +
      '~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup',
    ).toBeGreaterThanOrEqual(newest.mtime);
  });
});

describe('the shipped bundle carries the wiring the source claims', () => {
  const bundle = () => readFileSync(DIST, 'utf8');

  /**
   * ALL occurrences, not the first. There is more than one onToolCall in the bundle — the REPL
   * wires one to the terminal writer — and asserting against whichever appears first found the
   * REPL's and reported the run command's as missing. The same first-match trap cost time twice
   * today already.
   */
  const handlerBlocks = (hook: string): string[] => {
    const s = bundle();
    const out: string[] = [];
    for (let i = s.indexOf(hook); i !== -1; i = s.indexOf(hook, i + 1)) out.push(s.slice(i, i + 500));
    return out;
  };

  it('tool_run is emitted from a real onToolCall handler, not merely defined by the logger', () => {
    // The logger has DECLARED these event types since it was written. The defect was that
    // nothing emitted them, so asserting the string exists proves nothing — it has to appear
    // inside a handler the runner is given.
    const blocks = handlerBlocks('onToolCall:');
    expect(blocks.length, 'no onToolCall handler in the shipped bundle at all').toBeGreaterThan(0);
    expect(
      blocks.some((b) => /tool_run/.test(b)),
      'every onToolCall handler in the bundle goes somewhere other than the activity log — ' +
      'the orchestration records no tool usage',
    ).toBe(true);
  });

  it('tool_result is emitted with its outcome and duration', () => {
    const blocks = handlerBlocks('onToolResult:');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => /tool_result/.test(b) && /durationMs|ms:/.test(b))).toBe(true);
  });

  it('per-tool duration is measured in the executor', () => {
    expect(bundle()).toMatch(/durationMs/);
  });
});

/**
 * The launcher's pre-flight, executed. A guard that is only asserted as source text is the same
 * category of unproven as the thing it exists to catch.
 */
describe('the launcher refuses to start on a stale build', () => {
  const LAUNCHER = join(ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh');

  /** Lifts the pre-flight block and runs it against a fixture repo. */
  function runPreflight(opts: { distExists?: boolean; distNewer?: boolean; skip?: boolean }) {
    const src = readFileSync(LAUNCHER, 'utf8');
    const start = src.indexOf('if [ "${EPAM_SKIP_BUILD_STALENESS_CHECK:-0}" != "1" ]; then');
    expect(start, 'the staleness pre-flight was not found').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\nfi\n', start) + 4);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mkdtempSync, mkdirSync, writeFileSync: w, utimesSync } = require('node:fs');
    const dir = mkdtempSync(join(require('node:os').tmpdir(), 'stale-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    w(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    if (opts.distExists !== false) {
      w(join(dir, 'dist', 'epam.js'), '// built\n');
      const srcTime = statSync(join(dir, 'src', 'a.ts')).mtimeMs / 1000;
      // dist newer, or a minute older than src — the live shape was 18 hours older.
      const t = opts.distNewer === false ? srcTime - 60 : srcTime + 60;
      utimesSync(join(dir, 'dist', 'epam.js'), t, t);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process');
    try {
      const out = execFileSync('bash', ['-c',
        `REPO_ROOT=${JSON.stringify(dir)}
         ${opts.skip ? 'EPAM_SKIP_BUILD_STALENESS_CHECK=1' : ''}
         info() { echo "INFO:$*"; }; error() { echo "ERR:$*"; }
${block}
         echo "REACHED_LAUNCH"`,
      ], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stdout) + String(e.stderr) };
    }
  }

  it('a current build starts normally', () => {
    const r = runPreflight({});
    expect(r.out).toContain('REACHED_LAUNCH');
    expect(r.code).toBe(0);
  });

  it('a stale build stops the run before it spends anything', () => {
    const r = runPreflight({ distNewer: false });
    expect(r.out, 'the run proceeded on a stale binary — the live 2026-08-09 failure').not.toContain('REACHED_LAUNCH');
    expect(r.code).not.toBe(0);
  });

  it('and it says which file is newer, and how to fix it', () => {
    const r = runPreflight({ distNewer: false });
    expect(r.out).toMatch(/a\.ts/);
    expect(r.out).toMatch(/tsup/);
  });

  it('a missing build stops the run too', () => {
    const r = runPreflight({ distExists: false });
    expect(r.out).not.toContain('REACHED_LAUNCH');
    expect(r.code).not.toBe(0);
  });

  it('the deliberate override is honoured', () => {
    // An operator running an older binary on purpose must not be blocked by a guard that
    // cannot know their intent.
    const r = runPreflight({ distNewer: false, skip: true });
    expect(r.out).toContain('REACHED_LAUNCH');
  });
});
