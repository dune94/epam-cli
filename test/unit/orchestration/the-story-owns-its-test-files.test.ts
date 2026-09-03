import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * _project_owned_test_files RETURNED NOTHING FOR EVERY STORY, ALWAYS.
 *
 * claude.sh:5780 destructures the args it was handed:
 *
 *     const [, , , root, sid, prdPath] = process.argv;   // argv[3], argv[4], argv[5]
 *
 * but they are passed as `"$_plugin" "$_root" "$_sid" "$_prd"` — argv[1..4], with argv[1] already
 * consumed as the plugin path. So `root` received the STORY ID, `sid` received the PRD PATH, and
 * `prdPath` was undefined: readFileSync(undefined) throws, the catch exits 0, and the function
 * prints nothing. Every story, every project, since it was written.
 *
 * The consequence is not subtle. claude.sh only scopes verification when this returns files, so
 * external verification always ran the WHOLE suite. Live 2026-09-02 (AMSD-1919): validating one
 * line in CheckoutForm.tsx ran 746 suites / 3,385 tests with 15 jest workers at ~700-780MB, pinned
 * the run at 10,731MB of an 11,264MB cap, and stretched a ~70-second suite past 10 minutes under
 * constant reclaim. The story declares its own spec file; nothing could ever read it.
 *
 * Driven by the real PRD and the real codeline, because a fixture would have agreed with whatever
 * shape I imagined.
 */
describe('the files a story owns', () => {
  const REPO = path.resolve(__dirname, '../../..');
  const claude = path.join(REPO, 'orchestrations/scripts/claude.sh');
  const plugin = path.join(REPO, 'orchestrations/plugins/verification-plugin.js');

  // Drives the SHELL function end to end, which now delegates to the plugin through the one
  // generic invoker. Lifting all three keeps the harness faithful to what production executes.
  const runOwned = (root: string, sid: string, prd: string) => {
    const body = fs.readFileSync(claude, 'utf8');
    const parts = ['_verification_plugin_call', '_project_owned_test_files', '_project_scoped_test_command']
      .map((n) => {
        const m = body.match(new RegExp(`${n}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`));
        expect(m, `${n} not found in claude.sh`).toBeTruthy();
        return m![0];
      });
    const harness = `
set -uo pipefail
AUTOMATION_DIR="${path.join(REPO, 'orchestrations')}"
NODE_BIN="${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node"
${parts.join('\n')}
owned=$(_project_owned_test_files "${root}" "${sid}" "${prd}")
echo "OWNED=$owned"
echo "SCOPED=$(_project_scoped_test_command "${root}" "$owned")"
`;
    const r = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout ?? ''}`;
    return {
      owned: (out.match(/OWNED=(.*)/)?.[1] ?? '').trim(),
      scoped: (out.match(/SCOPED=(.*)/)?.[1] ?? '').trim(),
      raw: out,
    };
  };

  it('returns the spec file a story declares — synthetic project, so it never depends on one repo', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-'));
    fs.mkdirSync(path.join(repo, '.epam'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.epam', 'verification.json'), JSON.stringify({
      typecheck: { command: 'true' },
      test: { command: 'true', testFilePattern: '\\.(test|spec)\\.[jt]sx?$' },
    }));
    const prd = path.join(repo, 'prd.json');
    fs.writeFileSync(prd, JSON.stringify({
      stories: [{
        id: 'S-1',
        technicalNotes: { files: ['src/Thing.tsx', 'src/__tests__/Thing.spec.tsx', 'src/Other.tsx'] },
      }],
    }));

    const { owned: out } = runOwned(repo, 'S-1', prd);
    expect(out, 'returned nothing, so verification can never be scoped').not.toBe('');
    expect(out).toContain('src/__tests__/Thing.spec.tsx');
    expect(out, 'a non-test file leaked into the owned set').not.toContain('src/Thing.tsx');
  });

  it('returns the real spec file for whichever real story declares one', () => {
    // DERIVED, NEVER NAMED. An earlier version of this test hardcoded a machine path and a project
    // name, which is the thing the pipeline itself is forbidden to do — a test that only runs on
    // one laptop for one client is not a test of the pipeline.
    //
    // The project is whichever one has a PRD, the story is whichever declares a test file, and the
    // codeline is whatever that PRD's outputDirs point at. Skips loudly if nothing qualifies,
    // rather than passing on an empty search.
    const projectsDir = path.join(REPO, 'orchestrations/projects');
    let found: { prd: string; sid: string; root: string; spec: string } | null = null;

    for (const project of fs.readdirSync(projectsDir)) {
      const prd = path.join(projectsDir, project, 'prd.json');
      if (!fs.existsSync(prd)) continue;
      let j: any;
      try { j = JSON.parse(fs.readFileSync(prd, 'utf8')); } catch { continue; }
      const dirs = (j.project && j.project.outputDirs) || [];
      for (const s of (j.stories || [])) {
        const files = (s && s.technicalNotes && s.technicalNotes.files) || [];
        const spec = files.find((f: string) => /\.(test|spec)\.[jt]sx?$/.test(f));
        if (!spec) continue;
        const hit = dirs.find((d: any) => d && d.codeline === s.codeline) || dirs[0];
        const root = hit && hit.path;
        if (root && fs.existsSync(path.join(root, '.git'))) {
          found = { prd, sid: s.id, root, spec };
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      throw new Error('no project PRD declares a story with a test file on a checked-out codeline '
        + '— this test is driven by real inputs and will not pass on an empty search');
    }

    const { owned: out, scoped } = runOwned(found.root, found.sid, found.prd);
    expect(out, `story ${found.sid} declares ${found.spec} but the function returned nothing`)
      .not.toBe('');
    expect(out).toContain(path.basename(found.spec));

    // AND the scoped command must actually materialise — owning the file is useless if the
    // command that runs only it never gets built.
    expect(scoped, 'no scoped command, so the full suite still runs').not.toBe('');
    expect(scoped).toContain(path.basename(found.spec));
    expect(scoped).not.toContain('{files}');
  });

  it('the engine embeds no program of its own — the plugin owns the logic', () => {
    // Both of these were node programs written inside bash single-quoted strings: unrunnable
    // standalone, untestable, stderr to /dev/null. That is how an argument destructured one
    // position too far went unnoticed for the life of the function.
    const body = fs.readFileSync(claude, 'utf8');
    for (const name of ['_project_owned_test_files', '_project_scoped_test_command']) {
      const m = body.match(new RegExp(`${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`));
      expect(m, `${name} not found`).toBeTruthy();
      expect(m![0], `${name} still embeds a program`).not.toMatch(/require\(|process\.argv|const \[/);
    }
    // and the capability must exist where it belongs
    const plugin = require(path.join(REPO, 'orchestrations/plugins/verification-plugin.js'));
    expect(typeof plugin.ownedTestFiles).toBe('function');
    expect(typeof plugin.scopedTestCommand).toBe('function');
  });
});
