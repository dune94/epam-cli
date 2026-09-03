import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A ONE-LINE CHANGE MUST NOT RUN 3,385 TESTS.
 *
 * claude.sh:5034 asks the project for a SCOPED test command — run only the test files this story
 * owns — and falls back to the whole suite when none is declared. next.gotransit.com declares none,
 * so external verification ran all 746 suites to validate one line in CheckoutForm.tsx.
 *
 * Live 2026-09-02: that pinned the run at 10,731MB of an 11,264MB cap with 15 jest workers at
 * ~700-780MB each, stretched a ~70-second suite past 10 minutes under constant reclaim, and left
 * the host with 407MB free. The story's own suite is ONE file.
 *
 * The declaration belongs to the ECOSYSTEM PROVIDER layer, which owns stack facts by design
 * ("discovered at run time, never enumerated by the engine"), not to the engine.
 *
 * The second case is the one that would have made the fix inert: git-ops.sh merges the detected
 * manifest as { ...detected, ...existing }, so a codeline that ALREADY has a test section keeps it
 * wholesale — and every real codeline already has one. A new key must reach them too, without
 * overwriting a command an operator hand-tuned.
 */
describe('scoped test verification', () => {
  const REPO = path.resolve(__dirname, '../../..');
  const plugin = path.join(REPO, 'orchestrations/plugins/verification-plugin.js');

  const nodeRepo = () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-'));
    fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({
      name: 'x', version: '1.0.0', scripts: { test: 'jest' },
    }));
    return r;
  };

  it('the detected manifest declares a scoped command with a {files} placeholder', () => {
    delete require.cache[require.resolve(plugin)];
    const p = require(plugin);
    const d = p.detectTests(nodeRepo());
    expect(d && d.test, 'no test section detected').toBeTruthy();
    expect(d.test.scopedCommand, `declared: ${JSON.stringify(d.test)}`).toBeTruthy();
    expect(d.test.scopedCommand).toContain('{files}');
    // it must use the SAME runner the full command uses, not a second guess at the tool
    expect(d.test.scopedCommand.startsWith(d.test.command)).toBe(true);
  });

  it('the engine turns it into a real command for the story\'s own files', () => {
    const repo = nodeRepo();
    delete require.cache[require.resolve(plugin)];
    const p = require(plugin);
    const d = p.detectTests(repo);
    fs.mkdirSync(path.join(repo, '.epam'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.epam', 'verification.json'),
      JSON.stringify({ typecheck: { command: 'true' }, ...d }, null, 2));

    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       AUTOMATION_DIR="${path.join(REPO, 'orchestrations')}"
       NODE_BIN="${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node"
       . "${path.join(REPO, 'orchestrations/scripts/lib/story-guards.sh')}" 2>/dev/null || true
       _plugin="${plugin}"
       "$NODE_BIN" -e '
         const p = require(process.argv[1]);
         const m = p.readTestManifest(process.argv[2]);
         const tpl = m && m.ok && m.manifest.test && m.manifest.test.scopedCommand;
         if (typeof tpl === "string" && tpl.trim()) console.log(tpl.replace(/\\{files\\}/g, process.argv[3]));
       ' "$_plugin" "${repo}" "src/CheckoutForm.spec.tsx"`,
    ], { encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout ?? ''}`.trim();
    expect(out.length, 'no scoped command produced').toBeGreaterThan(0);
    expect(out).toContain('src/CheckoutForm.spec.tsx');
    expect(out).not.toContain('{files}');
  });

  it('a codeline that ALREADY has a test section still gains the new key', () => {
    const repo = nodeRepo();
    fs.mkdirSync(path.join(repo, '.epam'), { recursive: true });
    // exactly the shape next.gotransit.com carries today: hand-tuned, no scopedCommand
    const existing = {
      typecheck: { command: 'npm run check-types' },
      test: {
        command: 'npm run test',
        testFilePattern: '\\.(test|spec)\\.[jt]sx?$',
        failurePattern: '^\\s*FAIL\\s+(\\S+)',
        failureIdentity: '{1}',
        detected: 'package.json scripts.test',
      },
    };
    fs.writeFileSync(path.join(repo, '.epam', 'verification.json'), JSON.stringify(existing, null, 2));

    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       AUTOMATION_DIR="${path.join(REPO, 'orchestrations')}"
       NODE_BIN="${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node"
       . "${path.join(REPO, 'orchestrations/scripts/lib/git-ops.sh')}" 2>/dev/null || true
       if command -v _epam_write_verification_manifest >/dev/null 2>&1; then
         _epam_write_verification_manifest "${repo}"
       else
         echo "PROVISIONER_NOT_FOUND" >&2
       fi`,
    ], { encoding: 'utf8', timeout: 60_000 });

    const after = JSON.parse(fs.readFileSync(path.join(repo, '.epam', 'verification.json'), 'utf8'));
    expect(after.test.command, 'the hand-tuned command must survive').toBe('npm run test');
    expect(after.test.scopedCommand,
      `existing section kept wholesale, so the new key never arrives. stderr: ${r.stderr}`).toBeTruthy();
  });
});
