/**
 * A BASELINE THAT COULD NOT RUN IS NOT A BASELINE WITH NO FAILURES.
 *
 * Live 2026-09-07, run 20260906T225844Z. The writer produced a correct one-line fix and the story
 * failed 12 times against two tests it never touched:
 *
 *     Unable to find an element by: [data-testid="network-status-lines-container"]
 *
 * Those tests are TIME-DEPENDENT in the client codeline — Schedules/utils.ts hides service updates
 * for the first two hours of the day (BUSINESS_HOURS = 2) and jest.config.js pins TZ=UTC, so they
 * fail between 00:00 and 02:00 UTC and pass the other 22 hours. The two runs that succeeded ran at
 * 21:08 UTC; this one ran at 00:29.
 *
 * THE PIPELINE ALREADY HANDLES THAT. baseline_new_failures runs the suite again at the baseline
 * SHA and subtracts by identity, and the baseline runs MINUTES from the current one — so a
 * clock-dependent test fails on both sides and cancels out. The story is charged only for what it
 * actually broke.
 *
 * IT DID NOT RUN. `git worktree add` checks out tracked files only, so the baseline checkout has
 * no node_modules; they are linked in from the real codeline. The link list comes from the
 * project's vendorDirs, resolved from `<codeline>/.epam/dependency-check.json` — a file that does
 * not exist. metrolinx declares vendorDirs in EPAM_PROJECT_CONFIG_DIR instead. So nothing was
 * linked, the baseline suite could not start, the cache was written 0 BYTES, and an empty baseline
 * means "nothing was previously broken" — charging every pre-existing failure to the story.
 *
 * Measured on the real artefacts: baseline-failures-test-d1b54620cb87.txt was 0 bytes while the
 * same suite at that SHA, with node_modules linked by hand, reports 2 failures and two matching
 * FAIL lines.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const GATE = join(SCRIPTS, 'lib/tsc-baseline-gate.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * A codeline whose verification command CANNOT RUN without its vendor dir — the shape of every
 * real project, where the test runner lives in node_modules and git does not track it.
 *
 * The "suite" is a script inside the vendor dir that prints one FAIL line. If the vendor dir is
 * not linked into the baseline worktree the script is missing, the run produces no FAIL lines,
 * and the baseline comes back empty — exactly the live failure, without needing jest or a clock.
 */
function codeline(opts: { manifestIn: 'project-config' | 'codeline-epam' | 'nowhere' }) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-'));
  dirs.push(root);
  const repo = join(root, 'codeline');
  const cfg = join(root, 'project-config');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.epam'), { recursive: true });
  mkdirSync(cfg, { recursive: true });

  // The runner lives in the vendor dir and is gitignored, like every real node_modules.
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  const runner = join(repo, 'node_modules', '.bin', 'faketest');
  writeFileSync(runner, '#!/usr/bin/env bash\necho "FAIL src/pre-existing.spec.ts"\nexit 1\n');
  chmodSync(runner, 0o755);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.epam/\n');

  // The project's declaration of HOW to verify — read from the codeline's .epam by the engine.
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({
    test: {
      command: './node_modules/.bin/faketest',
      failurePattern: '^\\s*FAIL\\s+(\\S+)',
      failureIdentity: '{1}',
    },
  }, null, 2));

  const manifest = JSON.stringify({ vendorDirs: ['node_modules'] }, null, 2);
  if (opts.manifestIn === 'project-config') writeFileSync(join(cfg, 'dependency-check.json'), manifest);
  if (opts.manifestIn === 'codeline-epam') writeFileSync(join(repo, '.epam', 'dependency-check.json'), manifest);

  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'baseline');
  const sha = git('rev-parse', 'HEAD').trim();
  return { root, repo, cfg, sha };
}

/** Drives the REAL baseline_new_failures, exactly as run_external_verification does. */
function baselineDelta(cl: { root: string; repo: string; cfg: string; sha: string },
                       opts: { seedCache?: string } = {}) {
  const logDir = join(cl.root, 'logs');
  mkdirSync(logDir, { recursive: true });
  // WHAT THE PREVIOUS RUN LEFT BEHIND. A pipeline is almost never on its first run, and this cache
  // is keyed by baseline SHA — so the file a broken run wrote is exactly what the next one reads.
  if (opts.seedCache !== undefined) {
    writeFileSync(join(logDir, `baseline-failures-test-${cl.sha.slice(0, 12)}.txt`), opts.seedCache);
  }
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), cl.sha);
  // The caller hands in the ALREADY-CAPTURED current output — one pre-existing failure and nothing else.
  const cur = join(cl.root, 'current.txt');
  writeFileSync(cur, 'FAIL src/pre-existing.spec.ts\n');

  const script = join(cl.root, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'log(){ :; }; warning(){ :; }; info(){ :; }; error(){ :; }',
    `export AUTOMATION_DIR=${JSON.stringify(join(SCRIPTS, '..'))}`,
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cl.cfg)}`,
    `. ${JSON.stringify(GATE)}`,
    `out=$(baseline_new_failures ${JSON.stringify(cl.repo)} node ${JSON.stringify(logDir)} test ${JSON.stringify(cur)}); rc=$?`,
    'echo "RC=$rc"', 'echo "NEW=[$out]"',
  ].join('\n'));

  let out = '';
  try {
    out = execFileSync('bash', [script], { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: cl.cfg } });
  } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  const rc = Number((out.match(/RC=(\d+)/) || [])[1] ?? -1);
  const cache = join(logDir, `baseline-failures-test-${cl.sha.slice(0, 12)}.txt`);
  return { out, rc, cacheExists: existsSync(cache),
    cacheBytes: existsSync(cache) ? readFileSync(cache, 'utf8').length : -1 };
}

describe('the baseline comparison', () => {
  it('GUARD: with the manifest where the engine already looks, the pre-existing failure cancels', () => {
    // Proves the harness can produce a WORKING baseline, so the failure below is about resolution
    // and not about the fixture being unable to run at all.
    const r = baselineDelta(codeline({ manifestIn: 'codeline-epam' }));
    expect(r.cacheBytes, `baseline captured nothing:\n${r.out}`).toBeGreaterThan(0);
    expect(r.rc, `a pre-existing failure was charged to the story:\n${r.out}`).toBe(0);
  });

  it('finds vendorDirs when the project declares them in ITS OWN config dir', () => {
    /**
     * THE LIVE CASE. metrolinx's dependency-check.json lives in EPAM_PROJECT_CONFIG_DIR; the
     * codeline's .epam/ holds only codeline-facts.json, settings.json and verification.json.
     */
    const r = baselineDelta(codeline({ manifestIn: 'project-config' }));
    expect(r.cacheBytes,
      'the baseline suite could not run — vendor dirs were never linked into the worktree, so the '
      + 'cache is empty and every pre-existing failure is charged to the story')
      .toBeGreaterThan(0);
    expect(r.rc,
      'a pre-existing, time-dependent failure the story never touched failed the story — this is '
      + 'the unwinnable loop that burned 12 writer retries').toBe(0);
  });

  it('THE OTHER END — a baseline that truly cannot be resolved does not silently pass the story', () => {
    /**
     * With no manifest anywhere the vendor dir cannot be found, and the honest outcome is that the
     * failure is still reported — NOT that an empty baseline is read as "nothing was ever broken".
     * The unsafe direction here is silence.
     */
    const r = baselineDelta(codeline({ manifestIn: 'nowhere' }));
    expect(r.rc, 'an unresolvable baseline was treated as a clean one').not.toBe(0);
  });
});

describe('a cache left behind by a previous run', () => {
  /**
   * THE CASE THE FIRST FIX DID NOT COVER, and a live run proved it within the hour.
   *
   * Making the baseline able to run was necessary and not sufficient: the gate rebuilds the cache
   * only `if [ ! -f "$baseline_cache" ]`. The failed run of 2026-09-07 left
   * baseline-failures-test-d1b54620cb87.txt at 0 BYTES; the next run found the file PRESENT,
   * skipped rebuilding, and read it as "nothing was broken at baseline" — charging the story with
   * the same pre-existing failures again, for the same twelve retries.
   *
   * The harness had built a fresh log directory for every case, so `[ ! -f ]` was always true and
   * the branch the real pipeline takes on its SECOND run was never executed once.
   *
   * Presence is not validity. An empty cache is a FAILED baseline, never a clean one.
   */
  it('REBUILDS a 0-byte cache instead of trusting it', () => {
    const cl = codeline({ manifestIn: 'project-config' });
    const r = baselineDelta(cl, { seedCache: '' });
    expect(r.cacheBytes,
      'an empty cache from a previous run was trusted as "nothing was previously broken"')
      .toBeGreaterThan(0);
    expect(r.rc,
      'the story was charged for a pre-existing failure because of a stale empty cache').toBe(0);
  });

  it('REUSES a cache that has content — the saving is not thrown away', () => {
    // The cache exists to avoid re-running the most expensive gate in the run. A valid one must
    // still be honoured, or this trades one defect for a slower pipeline.
    const cl = codeline({ manifestIn: 'project-config' });
    // THE CACHE HOLDS PARSED IDENTITIES, not raw output — the gate writes ids.join("\n"), and
    // with failureIdentity "{1}" over ^\s*FAIL\s+(\S+) the identity is the spec path. Seeding the
    // raw line instead would test a format the pipeline never writes.
    const r = baselineDelta(cl, { seedCache: 'src/pre-existing.spec.ts\n' });
    expect(r.rc, 'a valid cached baseline did not cancel the pre-existing failure').toBe(0);
    expect(r.cacheBytes, 'a valid cache was discarded').toBeGreaterThan(0);
  });

  it('a WHITESPACE-ONLY cache is treated as empty, not as content', () => {
    const cl = codeline({ manifestIn: 'project-config' });
    const r = baselineDelta(cl, { seedCache: '   \n\n  \n' });
    expect(r.rc, 'a blank cache passed as a real baseline').toBe(0);
  });
});
