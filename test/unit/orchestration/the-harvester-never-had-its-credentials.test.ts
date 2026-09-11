/**
 * THE HARVESTER RAN FOR TWELVE HOURS AND READ NOTHING.
 *
 * cassette-watch.js turns a Langfuse session into a cassette. That is its whole job, and it needs
 * exactly two things: the cassette directory, and the Langfuse credentials the pipeline already
 * uses to WRITE traces. cassette-watch-control.sh's own header says both "come from the install's
 * own environment — nothing is guessed here". Only EPAM_CASSETTE_DIR was ever exported, and
 * pipeline-services.sh (the only caller) never loads the install's .env, so no LANGFUSE_* variable
 * was ever in scope at spawn time.
 *
 * Measured live 2026-09-11 on pipeline-tests-49: the watcher had been up 12 hours, /proc/<pid>/environ
 * held ZERO LANGFUSE_ variables, cassette-export.js --list exited non-zero for want of credentials,
 * listSessions() turned that non-zero into an empty array, and the sweep logged nothing because it
 * only logs when it harvests or fails. orchestrations/cassettes did not exist. A 154-trace run sat
 * unharvested in Langfuse the whole time.
 *
 * Three existing test files covered this component and all three passed, because every one of them
 * injected a working stub exporter — the single failure mode was the single path never executed.
 *
 * These two assert what was actually broken:
 *   1. what the SPAWNED PROCESS RECEIVES, not that a pid file appeared;
 *   2. that a failing exporter is REPORTED, not silently flattened to "no sessions".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CONTROL = join(ROOT, 'orchestrations-installer/lib/cassette-watch-control.sh');
const WATCH = join(ROOT, 'orchestrations/scripts/cassette-watch.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A fake install root carrying the credentials the real one carries in its .env. */
function fakeInstall() {
  const root = tmp('harv-creds-');
  mkdirSync(join(root, 'orchestrations/scripts'), { recursive: true });
  mkdirSync(join(root, 'orchestrations/dashboards'), { recursive: true });
  writeFileSync(join(root, 'orchestrations/scripts/cassette-watch.js'), '// stand-in\n');
  // The REAL shared loader, not a copy: the control script reads the .env through it.
  mkdirSync(join(root, 'orchestrations/scripts/lib'), { recursive: true });
  writeFileSync(join(root, 'orchestrations/scripts/lib/env-file.sh'),
    readFileSync(join(ROOT, 'orchestrations/scripts/lib/env-file.sh'), 'utf8'));
  writeFileSync(join(root, '.env'), [
    'LANGFUSE_PUBLIC_KEY=pk-test-harvester',
    'LANGFUSE_SECRET_KEY=sk-test-harvester',
    'LANGFUSE_BASE_URL=http://localhost:3100',
  ].join('\n') + '\n');
  return root;
}

describe('the harvester never had its credentials', () => {
  it('the spawned watcher RECEIVES the Langfuse credentials — read from its own /proc environ', () => {
    const root = fakeInstall();

    // A stand-in for node that simply stays alive, so its environment can be read from /proc.
    // Read from /proc rather than having it print: this is the same evidence that diagnosed the
    // live watcher, and it cannot be faked by the harness.
    const fakeNode = join(root, 'fake-node');
    writeFileSync(fakeNode, '#!/bin/bash\nsleep 30\n');
    chmodSync(fakeNode, 0o755);

    const harness = join(root, 'run.sh');
    writeFileSync(harness, [
      '#!/bin/bash',
      '_ok(){ echo "OK: $*"; }; _bad(){ echo "BAD: $*"; }; _warn(){ echo "WARN: $*"; }',
      `source ${JSON.stringify(CONTROL)}`,
      `NODE_BIN=${JSON.stringify(fakeNode)} start_cassette_watch ${JSON.stringify(root)}`,
    ].join('\n'));

    const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 60_000, cwd: root });
    const pidfile = join(root, 'orchestrations/dashboards/.cassette-watch.pid');
    expect(existsSync(pidfile), `the watcher never started. out: ${r.stdout}${r.stderr}`).toBe(true);
    const pid = readFileSync(pidfile, 'utf8').trim();

    let environ = '';
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n');
    } finally {
      spawnSync('kill', ['-9', pid]);
    }

    expect(environ.length, `could not read /proc/${pid}/environ — the watcher did not stay up`)
      .toBeGreaterThan(0);
    expect(environ, 'EPAM_CASSETTE_DIR was not passed').toMatch(/^EPAM_CASSETTE_DIR=/m);
    expect(environ,
      'the watcher was spawned with NO LANGFUSE_PUBLIC_KEY — it cannot read the sessions it exists to export')
      .toMatch(/^LANGFUSE_PUBLIC_KEY=pk-test-harvester$/m);
    expect(environ,
      'the watcher was spawned with NO LANGFUSE_SECRET_KEY — cassette-export.js --list exits non-zero forever')
      .toMatch(/^LANGFUSE_SECRET_KEY=sk-test-harvester$/m);
    expect(environ, 'the watcher was spawned with no LANGFUSE_BASE_URL')
      .toMatch(/^LANGFUSE_BASE_URL=http:\/\/localhost:3100$/m);
  });

  it('an exporter that cannot list is REPORTED, never flattened into "no sessions"', () => {
    const d = tmp('harv-fail-');
    const cass = join(d, 'cassettes');

    // The REAL failure: the exporter exits non-zero because it has no credentials.
    const failing = join(d, 'no-creds-exporter.js');
    writeFileSync(failing, [
      'process.stderr.write("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both required\\n");',
      'process.exit(1);',
    ].join('\n'));

    const { harvestOnce } = require(WATCH);
    const r = harvestOnce({ cassetteDir: cass, exporter: failing, node: process.execPath });

    expect(r.harvested, 'nothing can be harvested without credentials').toEqual([]);
    expect(r.unreadable ?? false,
      'a failing exporter was reported as an ordinary empty sweep — the harvester can die silently forever')
      .toBe(true);
  });
});
