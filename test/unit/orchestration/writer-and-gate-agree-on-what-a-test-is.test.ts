import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE WRITER AND THE GATE MUST AGREE ON WHAT A TEST IS — AND NEITHER MAY DECIDE IT.
 *
 * brownfield-repro-test-writer.sh resolves WHERE to write a test. brownfield-repro-test-gate.sh
 * decides WHETHER a test accompanies the change and hard-blocks if not. Both carried their own copy
 * of the convention:
 *
 *     the four-glob case statement matching .test. / .spec. / a __tests__ dir / _test.
 *
 * Three faults. Stack filenames hardcoded in engine code, which is not permitted. Two copies that
 * can drift, so the writer can produce a file the gate refuses. And a third declaration already
 * exists and is ignored: the project declares `testFilePattern` in .epam/verification.json, and
 * verification-plugin.js exports isTestFile() to read it.
 *
 * This is the end-to-end contract the unit fixes do not cover: what the writer produces, the gate
 * must accept. Live 2026-09-02 (AMSD-1919) the writer and the stage disagreed about .spec.ts vs
 * .spec.tsx and a fix shipped with no test while three models were escalated over it.
 */
describe('what counts as a test', () => {
  const gate = path.resolve(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-gate.sh');
  const writer = path.resolve(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');
  const plugin = path.resolve(__dirname, '../../../orchestrations/plugins/verification-plugin.js');

  const repoWith = (changed: string[]) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'develop');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 'T');
    fs.mkdirSync(path.join(repo, '.epam'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.epam', 'verification.json'), JSON.stringify({
      typecheck: { command: 'true' },
      test: { command: 'true', testFilePattern: '\\.(test|spec)\\.[jt]sx?$' },
    }));
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    g('add', '-A'); g('commit', '-qm', 'baseline');
    g('checkout', '-q', '-b', 'story');
    for (const f of changed) {
      fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), '// x\n');
    }
    g('add', '-A'); g('commit', '-qm', 'story change');
    return repo;
  };

  const runGate = (repo: string) => {
    const r = spawnSync('bash', [gate, 'STORY-1'], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop' },
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  it('the gate BLOCKS a change that ships no test', () => {
    const r = runGate(repoWith(['src/CheckoutForm.tsx']));
    expect(r.out.length, 'gate produced nothing — vacuous pass').toBeGreaterThan(0);
    expect(r.code, `gate should have blocked:\n${r.out}`).not.toBe(0);
    expect(r.out).toMatch(/BLOCK/i);
  });

  it('the gate RECOGNISES the .tsx test the writer now produces', () => {
    // Not asserting a pass: proving the reproduction needs a runnable suite, which a fixture has
    // no business faking. What must hold is the CLASSIFICATION — the gate must not claim the
    // change ships no test when the writer's own .spec.tsx is sitting in the diff.
    const r = runGate(repoWith(['src/CheckoutForm.tsx', 'src/CheckoutForm.spec.tsx']));
    expect(r.out.length, 'gate produced nothing').toBeGreaterThan(0);
    expect(r.out, `the gate did not see the writer's .spec.tsx as a test:\n${r.out}`)
      .not.toMatch(/no test file accompanies the change/i);
  });

  it('neither the writer nor the gate holds its own copy of the convention', () => {
    for (const f of [gate, writer]) {
      const code = fs.readFileSync(f, 'utf8').split('\n')
        .filter((l) => !l.trim().startsWith('#')).join('\n');
      const globs = code.match(/\*\.(test|spec)\.\*|\*_test\.\*|\*\/__tests__\/\*/g) ?? [];
      expect(globs, `${path.basename(f)} hardcodes the test-file convention: ${globs.join(' ')}`)
        .toEqual([]);
    }
  });

  it('the declared pattern is what decides — the plugin already answers this', () => {
    delete require.cache[require.resolve(plugin)];
    const p = require(plugin);
    const repo = repoWith(['src/a.tsx']);
    expect(typeof p.isTestFile, 'verification-plugin does not expose isTestFile').toBe('function');
    expect(p.isTestFile(repo, 'src/CheckoutForm.spec.tsx')).toBe(true);
    expect(p.isTestFile(repo, 'src/CheckoutForm.tsx')).toBe(false);
  });
});
