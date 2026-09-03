/**
 * A 40-ASSERTION TEST SUITE THAT BASH REFUSED TO PARSE.
 *
 * orchestrations/scripts/test/test-epam-providers.sh checks provider routing, cost normalisation
 * and external verification — zero tokens, no API calls, forty assertions. It measured 0% covered,
 * and the reason was not that nothing exercised it: an orphaned continuation sat at line 374, a
 * `<<< ... ) || true` tail whose opening command had been deleted. `bash -n` fails on it. So the
 * file could not run AT ALL, and nothing in the repository ran it — it is named by two config files
 * and no runner.
 *
 * That is the failure mode this wrapper exists to stop: a suite nobody invokes decays in silence,
 * and its rot is invisible precisely because an unexecuted file reports no failures. Running it from
 * the vitest suite makes a syntax error a red test the same day, rather than a discovery months
 * later made while chasing a coverage number.
 *
 * IT ASSERTS THE SUITE PASSES, NOT MERELY THAT IT PARSES. Parsing was the old bar, and it was
 * cleared by a file carrying eight real failures.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();
const SUITE = join(REPO, 'orchestrations/scripts/test/test-epam-providers.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

const run = spawnSync('bash', [SUITE], {
  encoding: 'utf8', timeout: 300000, cwd: REPO,
  env: { ...process.env, NODE_BIN: NODE20 },
});
const out = (run.stdout || '') + (run.stderr || '');
const results = /Results: (\d+)\/(\d+) passed/.exec(out);

/** The suite colours its output; compare on the text, not the escape codes. */
const stripAnsi = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');

describe('the provider routing suite actually runs', () => {
  it('parses — a syntax error here means the file cannot run at all', () => {
    const check = spawnSync('bash', ['-n', SUITE], { encoding: 'utf8', timeout: 30000 });
    expect(check.status, `bash refuses the file:\n${check.stderr}`).toBe(0);
  }, 40_000);

  it('reaches its own summary, so every assertion was reached', () => {
    // Without this, a suite that died halfway would present as a small number of failures.
    expect(results, `the suite never printed a summary; it stopped early:\n${out.slice(-600)}`)
      .not.toBeNull();
    expect(Number(results![2]), 'the suite declares too few assertions to be the one described')
      .toBeGreaterThan(20);
  }, 320_000);

  it('and every assertion passes', () => {
    const failures = stripAnsi(out).split('\n')
      .filter((l) => /\bFAIL\b/.test(l))
      .map((l) => l.trim());
    expect(failures, `${failures.length} assertion(s) fail:\n${failures.join('\n')}`).toEqual([]);
    expect(run.status, 'the suite exited non-zero').toBe(0);
  }, 320_000);
});
