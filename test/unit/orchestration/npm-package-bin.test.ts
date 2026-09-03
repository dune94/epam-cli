import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * bin/amsd-pipeline.js is deliberately thin: it must exec bash on THIS package's own install.sh
 * with every argv forwarded, and propagate bash's real exit code — never swallow it into a
 * generic 0/1. Verified against a STUB bash that records its own argv and exits a chosen code,
 * so this proves the wiring, not bash's own behavior.
 */
const REPO = path.resolve(__dirname, '../../..');
const BIN = path.join(REPO, 'npm-package/amsd-pipeline/bin/amsd-pipeline.js');

function fixture(bashExitCode: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amsd-pipeline-bin-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'bash.log');
  fs.writeFileSync(path.join(bin, 'bash'), `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exit ${bashExitCode}
`);
  fs.chmodSync(path.join(bin, 'bash'), 0o755);
  return { dir, bin, log };
}

const run = (f: { bin: string }) =>
  spawnSync('node', [BIN, '--docker', '--dest', '/some/path'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
  });

describe('npm-package/amsd-pipeline/bin/amsd-pipeline.js', () => {
  it('execs bash on THIS package\'s own install.sh, with every argv forwarded', () => {
    const f = fixture(0);
    const r = run(f);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const log = fs.readFileSync(f.log, 'utf8');
    expect(log, `bash was not invoked with the packaged install.sh:\n${log}`).toMatch(/amsd-pipeline[/\\]install\.sh/);
    expect(log).toMatch(/--docker/);
    expect(log).toMatch(/--dest\s+\/some\/path/);
  });

  it('propagates bash\'s real exit code, never a generic pass/fail', () => {
    const f = fixture(17);
    const r = run(f);
    expect(r.status).toBe(17);
  });
});
