/**
 * THE PIPELINE IS LINTED, BECAUSE IT NEVER WAS.
 *
 * The repo's eslint config ends with ignorePatterns ["dist/", "node_modules/", "*.js"] and its
 * script is `eslint src --ext .ts`. Every .js file was excluded — which is the entire
 * orchestration tree, where the pipeline logic lives and where every defect this week was
 * found.
 *
 * 2026-08-08: a variable was deleted during a refactor and a reference to it twelve lines
 * below survived. It reached a LIVE RUN, threw on every detective invocation — three attempts,
 * three lanes — and produced no fix sites at all, while a suite of 8821 tests stayed green,
 * because the extracted helper was unit tested in isolation and nothing executed the function
 * containing the dangling reference. `no-undef` finds it in under a second.
 *
 * That first lint pass also surfaced two pre-existing faults nobody had seen: an implicit
 * global in the webhook queue, and a duplicated export key.
 *
 * This test fails if the lint pass is removed or stops being clean — the check is worthless if
 * it is not run.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');

describe('the lint pass exists and is wired', () => {
  it('a config covering the orchestration javascript is present', () => {
    expect(existsSync(join(REPO, 'eslint.orchestrations.config.mjs'))).toBe(true);
  });

  it('an npm script runs it, so it is not a thing only one person knows about', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:orchestrations']).toBeTruthy();
  });

  it('it enables no-undef — the rule that would have caught the live failure', () => {
    const cfg = readFileSync(join(REPO, 'eslint.orchestrations.config.mjs'), 'utf8');
    expect(cfg).toMatch(/'no-undef':\s*'error'/);
  });
});

describe('the orchestration javascript passes it', () => {
  it('no errors', () => {
    let out = '';
    try {
      execFileSync('./node_modules/.bin/eslint', [
        '-c', 'eslint.orchestrations.config.mjs',
        'orchestrations/scripts/**/*.js',
        '--ignore-pattern', '**/.venv-*/**',
      ], { cwd: REPO, encoding: 'utf8' });
    } catch (e: any) {
      out = String(e.stdout || e.message || '');
    }
    // Warnings are tolerated; an ERROR means code that cannot work.
    const errorLines = out.split('\n').filter((l) => / error /.test(l));
    expect(errorLines.join('\n'), 'the pipeline has lint errors — code that cannot run').toEqual('');
  }, 120_000);
});
