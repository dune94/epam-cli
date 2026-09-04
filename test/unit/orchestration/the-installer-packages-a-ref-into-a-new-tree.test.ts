import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * install.sh --dest IS WHAT MAKES THIS AN INSTALLER FOR SOMEONE WHO IS NOT THIS CHECKOUT.
 *
 * Without it, install.sh only ever configures a tree that already exists — which presupposes the
 * code arrived by some hand-run means (a manual `git archive`, done by a human or an LLM standing
 * in for one, every single time this session). --dest packages a REF into a fresh tree itself, then
 * runs the rest of the install against it.
 *
 * REAL git repos, not stubs: the actual defect this caught was `git archive` scoping its output to
 * the CURRENT WORKING DIRECTORY'S subtree, not the whole repo — running it via `git -C
 * $INSTALLER_DIR archive` (INSTALLER_DIR being orchestrations-installer/, a SUBDIRECTORY) silently
 * archived only install.sh and lib/, dropping the entire rest of the pipeline. Found by actually
 * running the packaged result and watching the very next step fail, not by reading git-archive's
 * docs and assuming. A fixture with fake docker/podman binaries (the pattern used elsewhere in this
 * file) cannot catch this class of bug — only a real git repo with install.sh in a subdirectory of
 * it, exactly as this codebase is laid out, can.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER_REL = 'orchestrations-installer/install.sh';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A real, minimal git repo laid out the SAME way as this one: install.sh in a subdirectory, real
 * pipeline files at the repo root. */
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-pkg-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);

  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });

  const installerSrc = fs.readFileSync(path.join(REPO, INSTALLER_REL), 'utf8');
  fs.writeFileSync(path.join(dir, INSTALLER_REL), installerSrc);
  fs.chmodSync(path.join(dir, INSTALLER_REL), 0o755);
  for (const f of ['container-runtime.sh', 'wait-for-health.sh', 'isolated-compose-identity.sh', 'generate-env-example.sh', 'preserve-run-state.sh', 'preserve-operator-config.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/run-state-paths.json'), path.join(dir, 'orchestrations-installer/run-state-paths.json'));
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/operator-config-paths.json'), path.join(dir, 'orchestrations-installer/operator-config-paths.json'));
  fs.mkdirSync(path.join(dir, 'orchestrations/projects/acme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'orchestrations/projects/acme/config.env'), 'JIRA_CODELINE_ROOT=/original/path\n');
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json', 'env-vars.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'GITHUB_PERSONAL_ACCESS_TOKEN=\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  // A REAL pipeline file at the ROOT, sibling to (not inside) orchestrations-installer/ — this is
  // exactly what the subdirectory-scoping bug silently dropped.
  fs.writeFileSync(path.join(dir, 'a-real-pipeline-file.txt'), 'this must survive packaging\n');

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  git(dir, ['tag', 'v1.0-test']);

  return dir;
}

/** Commits a second version — including a file at a RUN-STATE path (simulating this repo's own
 * real history, where orchestrations/logs/ carries thousands of tracked files) — and tags it. */
function addSecondVersion(repoDir: string) {
  fs.writeFileSync(path.join(repoDir, 'a-real-pipeline-file.txt'), 'version 2 of the app code\n');
  fs.mkdirSync(path.join(repoDir, 'orchestrations/logs'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'orchestrations/logs/committed-fixture.json'), 'from v2.0 of the ref');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'v2']);
  git(repoDir, ['tag', 'v2.0-test']);
}

function run(repoDir: string, args: string[]) {
  return execFileSync('bash', [path.join(repoDir, INSTALLER_REL), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(repoDir, 'bin-shim') },
  });
}

describe('install.sh --dest packages a ref into a NEW tree', () => {
  it('the packaged tree contains the WHOLE repo, not just orchestrations-installer/', () => {
    // THE ACTUAL REGRESSION: this must include a-real-pipeline-file.txt, which lives OUTSIDE
    // orchestrations-installer/ — the exact content the subdirectory-scoping bug dropped.
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    let out = '';
    try {
      out = run(repo, ['--dest', dest, '--ref', 'v1.0-test', '--no-docker']);
    } catch (e: any) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(fs.existsSync(path.join(dest, 'a-real-pipeline-file.txt')),
      `packaging dropped root-level content:\n${out.slice(-800)}`).toBe(true);
    expect(fs.existsSync(path.join(dest, 'orchestrations/config/provider-sets.json')),
      `packaging dropped orchestrations/:\n${out.slice(-800)}`).toBe(true);
  });

  it('installs INTO the packaged tree, not the original checkout', () => {
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    run(repo, ['--dest', dest, '--ref', 'v1.0-test', '--no-docker']);
    expect(fs.existsSync(path.join(dest, '.env')), 'the install ran against the wrong tree').toBe(true);
    expect(fs.existsSync(path.join(repo, '.env')), 'the ORIGINAL checkout was modified — it must not be').toBe(false);
  });

  it('a ref that does not exist fails loudly, never silently packaging HEAD instead', () => {
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    expect(() => run(repo, ['--dest', dest, '--ref', 'no-such-ref-exists', '--no-docker'])).toThrow();
    expect(fs.existsSync(path.join(dest, 'package.json')),
      'packaged something despite the ref not existing').toBe(false);
  });

  /** A bare install.sh, deliberately NOT inside any git checkout — the exact "only this one file"
   * scenario --repo's self-clone exists for. */
  function bareInstallerNoCheckout() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-nogit-'));
    fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO, INSTALLER_REL), path.join(dir, INSTALLER_REL));
    fs.chmodSync(path.join(dir, INSTALLER_REL), 0o755);
    return dir;
  }

  it('NOTHING PRE-EXISTING REQUIRED: outside any checkout, --repo clones itself — never a manual git clone', () => {
    // --repo points at a REAL local repo, not the real GitHub network: proves the self-clone
    // mechanism itself works, fast and offline, without this test depending on network access.
    const sourceRepo = fixtureRepo();
    const dir = bareInstallerNoCheckout();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    const out = run(dir, ['--dest', dest, '--repo', sourceRepo, '--ref', 'v1.0-test', '--no-docker']);
    expect(fs.existsSync(path.join(dest, 'a-real-pipeline-file.txt')),
      `self-clone + package did not produce a working tree:\n${out.slice(-800)}`).toBe(true);
    expect(fs.existsSync(path.join(dest, '.env')), 'the install did not proceed after self-cloning').toBe(true);
  });

  it('an unreachable --repo fails loudly, never silently proceeding with nothing', () => {
    const dir = bareInstallerNoCheckout();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-dest-'));
    expect(() => run(dir, ['--dest', dest, '--repo', '/no/such/path/exists', '--no-docker'])).toThrow();
  });

  it('with no --dest, behaves exactly as before — configures the tree it is sitting in', () => {
    const repo = fixtureRepo();
    const out = run(repo, ['--no-docker']);
    expect(fs.existsSync(path.join(repo, '.env')), `no --dest must install in place:\n${out.slice(-800)}`).toBe(true);
  });

  it('AN UPDATE never destroys run evidence, even on a direct filename collision', () => {
    // The exact scenario found 2026-09-03: a colleague's install has real live data at a path the
    // newer ref's git history ALSO tracks something at. Re-running --dest against the SAME
    // destination with a newer --ref must not let the ref's committed content win.
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-update-dest-'));

    // First install, v1.0.
    run(repo, ['--dest', dest, '--ref', 'v1.0-test', '--no-docker']);
    expect(fs.existsSync(path.join(dest, 'a-real-pipeline-file.txt'))).toBe(true);

    // The colleague actually uses it: real run evidence accumulates, AT THE SAME PATH the next
    // version's git history will also carry a committed file.
    fs.mkdirSync(path.join(dest, 'orchestrations/logs'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'orchestrations/logs/committed-fixture.json'),
      'THIS COLLEAGUE\'S OWN REAL RUN DATA — must survive an update');
    fs.writeFileSync(path.join(dest, 'orchestrations/logs/only-this-colleague-has-this.json'),
      'never existed in any git ref');

    // A newer version is released and the colleague updates.
    addSecondVersion(repo);
    const out = run(repo, ['--dest', dest, '--ref', 'v2.0-test', '--no-docker']);

    // App code DID update.
    expect(fs.readFileSync(path.join(dest, 'a-real-pipeline-file.txt'), 'utf8'),
      `code was not updated:\n${out.slice(-800)}`).toContain('version 2');
    // Run evidence at the SAME path the ref also tracks something at — untouched.
    expect(fs.readFileSync(path.join(dest, 'orchestrations/logs/committed-fixture.json'), 'utf8'),
      'the update overwrote real run evidence with the ref\'s own committed content')
      .toContain('THIS COLLEAGUE\'S OWN REAL RUN DATA');
    // A file that exists ONLY on this install, nowhere in git history — still there.
    expect(fs.existsSync(path.join(dest, 'orchestrations/logs/only-this-colleague-has-this.json')),
      'a file with no counterpart in the ref was deleted by the update').toBe(true);
  });

  it('AN UPDATE never overwrites an operator\'s existing project config.env either', () => {
    // Found 2026-09-03: JIRA_CODELINE_ROOT is a per-INSTALL operator setting (e.g. pointed at a
    // test copy of the codelines). A DIFFERENT mechanism from run-state-paths.json's excludes on
    // purpose — proven by the second half of this test: a blanket exclude would ALSO block a
    // brand-new project's config.env from ever being extracted, which must still work.
    const repo = fixtureRepo();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-update-opcfg-dest-'));

    run(repo, ['--dest', dest, '--ref', 'v1.0-test', '--no-docker']);
    expect(fs.readFileSync(path.join(dest, 'orchestrations/projects/acme/config.env'), 'utf8'))
      .toContain('/original/path');

    // The operator edits it locally — exactly what pointing at a test-copy codeline root is.
    fs.writeFileSync(path.join(dest, 'orchestrations/projects/acme/config.env'),
      'JIRA_CODELINE_ROOT=/operator/edited/test/path\n');

    // A newer ref ships a DIFFERENT committed value at the same path, AND a whole new project.
    fs.writeFileSync(path.join(repo, 'orchestrations/projects/acme/config.env'), 'JIRA_CODELINE_ROOT=/whatever/head/says/now\n');
    fs.mkdirSync(path.join(repo, 'orchestrations/projects/newproj'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'orchestrations/projects/newproj/config.env'), 'JIRA_CODELINE_ROOT=/newproj/default\n');
    addSecondVersion(repo);
    const out = run(repo, ['--dest', dest, '--ref', 'v2.0-test', '--no-docker']);

    // The operator's edit survived the update — the ref's own committed value did NOT win.
    expect(fs.readFileSync(path.join(dest, 'orchestrations/projects/acme/config.env'), 'utf8'),
      `operator's config.env edit was overwritten by the update:\n${out.slice(-800)}`)
      .toContain('/operator/edited/test/path');

    // A project that did not exist before IS still created by the update — this is what proves
    // the mechanism is "preserve if existing", never a blanket exclude that would break this.
    expect(fs.existsSync(path.join(dest, 'orchestrations/projects/newproj/config.env')),
      'a brand-new project\'s config.env was never extracted at all').toBe(true);
    expect(fs.readFileSync(path.join(dest, 'orchestrations/projects/newproj/config.env'), 'utf8'))
      .toContain('/newproj/default');
  });
});
