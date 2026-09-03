import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A BASELINE FOR THE TEST SUITE MUST RUN THE TEST SUITE.
 *
 * baseline_new_failures(project, node, log_dir, section, output) is called with section="test" from
 * claude.sh's external-verification path. To build the baseline it calls _run_project_verification,
 * which calls verification-plugin.js runVerification() — and readManifest() read ONE key:
 *
 *     const command = parsed && parsed.typecheck && parsed.typecheck.command;
 *
 * So the "test baseline" ran the TYPECHECK command. Its output carries no suite failures, the parse
 * finds none, the node call exits non-zero, and the caller's `rm -f "$baseline_cache"` deletes the
 * cache. No cache means nothing is subtracted, so every pre-existing suite failure is attributed to
 * the story.
 *
 * Live 2026-09-02, AMSD-1919: no baseline-failures-* file had EVER been produced on this machine,
 * for any section. A pre-existing flake (FullScheduleTable/SearchBox.spec.tsx) was blamed on a
 * one-line CheckoutForm.tsx change, and the writer exhausted its retries against a failure it could
 * not fix. The project already declared a `test` section; nothing read it.
 */
describe('verification manifest, per section', () => {
  const plugin = path.resolve(__dirname, '../../../orchestrations/plugins/verification-plugin.js');

  const repoWithManifest = () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-'));
    fs.mkdirSync(path.join(repo, '.epam'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.epam', 'verification.json'), JSON.stringify({
      typecheck: { command: 'echo RAN_TYPECHECK' },
      test: { command: 'echo RAN_TEST' },
      lint: { command: 'echo RAN_LINT' },
    }, null, 2));
    return repo;
  };

  it('runs the TEST command when asked for the test section', () => {
    delete require.cache[require.resolve(plugin)];
    const p = require(plugin);
    const repo = repoWithManifest();
    const r = p.runVerification(repo, undefined, 'test');
    expect(r, 'runVerification returned nothing').toBeTruthy();
    expect(`${r.output ?? ''}`, `ran the wrong section: ${JSON.stringify(r).slice(0, 200)}`)
      .toContain('RAN_TEST');
  });

  it('still runs the TYPECHECK command when asked for typecheck', () => {
    delete require.cache[require.resolve(plugin)];
    const p = require(plugin);
    const repo = repoWithManifest();
    const r = p.runVerification(repo, undefined, 'typecheck');
    expect(`${r.output ?? ''}`).toContain('RAN_TYPECHECK');
  });

  it('defaults to typecheck when no section is named, as before', () => {
    delete require.cache[require.resolve(plugin)];
    const p = require(plugin);
    const repo = repoWithManifest();
    const r = p.runVerification(repo);
    expect(`${r.output ?? ''}`).toContain('RAN_TYPECHECK');
  });

  it('the shell passes its section through — the plugin honouring it is useless unwired', () => {
    const repo = repoWithManifest();
    const gate = path.resolve(__dirname, '../../../orchestrations/scripts/lib/tsc-baseline-gate.sh');
    const run = (section: string) => {
      const r = spawnSync('bash', ['-c',
        `set -uo pipefail
         AUTOMATION_DIR="${path.resolve(__dirname, '../../../orchestrations')}"
         NODE_BIN="${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node"
         . "${gate}"
         _run_project_verification "${repo}" ${section}`,
      ], { encoding: 'utf8', timeout: 60_000 });
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    };
    const asTest = run('test');
    expect(asTest.length, 'no output — vacuous pass').toBeGreaterThan(0);
    expect(asTest, `the shell did not pass the section:\n${asTest}`).toContain('RAN_TEST');
    expect(run('typecheck')).toContain('RAN_TYPECHECK');
    expect(run(''), 'the default must stay typecheck').toContain('RAN_TYPECHECK');
  });
});
