/**
 * PRE-FLIGHT KEEPS A CLEAN SHELLCHECK VERDICT PER DIGEST.
 *
 * shellcheck holds ~3.3 GB for the 11,000-line orchestrator and takes ten seconds. Pre-flight ran
 * it on every launch, so every launch cost that — and under a memory cap sized to the host it was
 * the one step that could not fit: the £0 greenfield rehearsal was killed here twice on
 * 2026-09-13. The verdict is a function of the bytes: a clean verdict is recorded under the
 * script's sha256 and a launch of unchanged bytes reads the record; a failing verdict is never
 * recorded. The block is lifted from the script and EXECUTED with a stub shellcheck that counts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/preflight-check.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function harness(opts: { verdict: 'clean' | 'errors' }) {
  const d = mkdtempSync(join(tmpdir(), 'sc-cache-')); dirs.push(d);
  const bin = join(d, 'bin'); mkdirSync(bin);
  const calls = join(d, 'calls.txt');
  writeFileSync(join(bin, 'shellcheck'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\n${opts.verdict === 'clean' ? 'exit 0' : 'exit 1'}\n`);
  chmodSync(join(bin, 'shellcheck'), 0o755);
  const runner = join(d, 'runner.sh'); writeFileSync(runner, '#!/bin/bash\necho hi\n');
  const start = SRC.indexOf('  if command -v shellcheck &>/dev/null; then');
  const end = SRC.indexOf('    ok "shellcheck not installed — skipping"\n  fi', start) + '    ok "shellcheck not installed — skipping"\n  fi'.length;
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const block = SRC.slice(start, end);
  const script = `set -uo pipefail\nSCRIPT_DIR=${JSON.stringify(d)}\nRUNNER_SCRIPT=${JSON.stringify(runner)}\nok(){ echo "OK: $*"; }; fail(){ echo "FAIL: $*"; }\n${block}\n`;
  writeFileSync(join(d, 'run.sh'), script);
  const run = () => {
    const r = spawnSync('bash', [join(d, 'run.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return (r.stdout || '') + (r.stderr || '');
  };
  const invocations = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  return { d, runner, run, invocations };
}

describe('pre-flight keeps a clean shellcheck verdict per digest', () => {
  it('a clean verdict is recorded and the second launch of the same bytes does not run shellcheck', () => {
    const h = harness({ verdict: 'clean' });
    expect(h.run()).toMatch(/OK: shellcheck clean$/m);
    expect(h.invocations()).toBe(1);
    expect(readdirSync(join(h.d, '.preflight-cache')).some((f) => /^shellcheck-[0-9a-f]{64}\.ok$/.test(f))).toBe(true);
    expect(h.run()).toMatch(/verdict recorded for these exact bytes/);
    expect(h.invocations()).toBe(1);
  });

  it('changed bytes are checked again', () => {
    const h = harness({ verdict: 'clean' });
    h.run(); h.run();
    writeFileSync(h.runner, '#!/bin/bash\necho changed\n');
    h.run();
    expect(h.invocations()).toBe(2);
  });

  it('a failing verdict is reported every time and never recorded', () => {
    const h = harness({ verdict: 'errors' });
    expect(h.run()).toMatch(/FAIL: shellcheck errors/);
    expect(h.run()).toMatch(/FAIL: shellcheck errors/);
    expect(h.invocations()).toBe(2);
    expect(existsSync(join(h.d, '.preflight-cache'))).toBe(false);
  });
});
