#!/usr/bin/env node
/**
 * mock-estate-seed — materialise the disposable multi-codeline estate used by the pipeline
 * integration tests.
 *
 * WHY IT EXISTS. The previous mock estate was one repository holding one function, and a story
 * that edited one line of it. At that scale every parent-vs-lane defect is invisible (with one
 * lane the parent's wrong answer and the lane's right answer coincide) and there is nothing an
 * investigator can find that the ticket did not already state. Both defects found on
 * 2026-08-08 — the control-plane port and the checkpoint directory — need more than one lane
 * to show at all.
 *
 * WHAT IT BUILDS. One git repository per codeline, each a small Contentstack + React site
 * sharing the same SDK service layer, differing ONLY in where content is fetched: a hook, a
 * page, or an app-wide provider. That difference is the point — one estate-wide sweep cannot
 * produce a single answer that fits all three, so a per-codeline investigator is the only way
 * to be right, exactly as in the estate this pipeline runs against.
 *
 * The codeline names come from the variants directory, so adding a codeline is adding a
 * directory. Content lives in test/fixtures/mock-estate and is never authored in a test file.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIXTURE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'mock-estate');
const APP = path.join(FIXTURE, 'app');
const VARIANTS = path.join(FIXTURE, 'variants');

function arg(flag, def = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function buildCodeline(root, staging, name, sharedModules) {
  // Staging lives OUTSIDE the codeline root: it holds a bare origin and a seed working copy,
  // both of which are git repositories, and codeline discovery scans the root for those. Left
  // inside, a three-codeline estate presents as six repositories.
  const base = path.join(staging, name);
  const bare = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', bare]);

  copyTree(APP, seed);
  copyTree(path.join(VARIANTS, name), seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules\n');
  // The site's own name, so the three repositories are not byte-identical.
  const pkg = JSON.parse(fs.readFileSync(path.join(seed, 'package.json'), 'utf8'));
  pkg.name = name;
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify(pkg, null, 2));

  git(seed, ['init', '--quiet', '--initial-branch=main']);
  git(seed, ['config', 'user.email', 'test@test.com']);
  git(seed, ['config', 'user.name', 'Test']);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-m', `seed: ${name} baseline`, '--quiet']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main', '--quiet']);

  const clone = path.join(root, name);
  execFileSync('git', ['clone', '--quiet', bare, clone]);
  git(clone, ['config', 'user.email', 'test@test.com']);
  git(clone, ['config', 'user.name', 'Test']);
  if (sharedModules) {
    try { fs.symlinkSync(sharedModules, path.join(clone, 'node_modules')); } catch { /* best effort */ }
  }
  return clone;
}

/**
 * Make every dependency the app DECLARES resolvable in the shared modules directory.
 *
 * Some are installed there; the rest are linked from this repository's own node_modules when
 * the same package is present. That is not a shortcut — it is how a hoisted workspace resolves,
 * and it keeps the fixture honest: the app's package.json is the source of truth, and a package
 * it declares but nothing provides is reported rather than silently missing.
 *
 * Done HERE rather than by hand because `npm install` prunes anything absent from its own
 * manifest: a link added manually to that directory disappears the next time npm touches it,
 * which is exactly how the test runner went missing after an unrelated install.
 */
function reconcileModules(sharedModules, repoModules) {
  if (!sharedModules || !fs.existsSync(sharedModules)) return { linked: [], missing: [] };
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const linked = [], missing = [];
  for (const name of declared) {
    const target = path.join(sharedModules, ...name.split('/'));
    if (fs.existsSync(target)) continue;
    const source = repoModules ? path.join(repoModules, ...name.split('/')) : '';
    if (source && fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.symlinkSync(source, target); linked.push(name); } catch { missing.push(name); }
      // The executable too, when the package ships one under the same name.
      const bin = repoModules ? path.join(repoModules, '.bin', name) : '';
      if (bin && fs.existsSync(bin)) {
        const dstBin = path.join(sharedModules, '.bin', name);
        fs.mkdirSync(path.dirname(dstBin), { recursive: true });
        try { fs.symlinkSync(bin, dstBin); } catch { /* already there */ }
      }
    } else {
      missing.push(name);
    }
  }
  return { linked, missing };
}

/**
 * provisionDeps — install the app's real dependencies ONCE, before any pipeline runs.
 *
 * WHY IT IS ITS OWN STEP. A pipeline run must not pay for an install. Worse, an install that
 * runs inside a run can DELETE what a previous one put there: `npm install` prunes anything
 * absent from its own manifest, which is how the test runner silently vanished mid-session and
 * left three codelines unable to run their tests.
 *
 * Idempotent by construction: if every declared dependency already resolves, it does nothing
 * and says so. Re-provisioning after the directory is emptied (a reboot, a stray install) is
 * the same command.
 *
 * The declared set comes from the app's own package.json — the fixture is the source of truth,
 * and a dependency added there is provisioned without editing this script.
 */
function provisionDeps(depsDir, repoModules) {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const modules = path.join(depsDir, 'node_modules');

  const resolves = (name) => fs.existsSync(path.join(modules, ...name.split('/')));
  const absent = Object.keys(declared).filter((n) => !resolves(n));
  if (!absent.length) return { installed: [], linked: [], alreadyComplete: true };

  fs.mkdirSync(depsDir, { recursive: true });
  const manifest = path.join(depsDir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify(
      { name: 'mock-estate-deps', version: '1.0.0', private: true }, null, 2));
  }

  // Install only what the registry can supply quickly. Anything this repository already
  // provides at the SAME version is linked instead: identical bytes, no download, and it keeps
  // a heavyweight tree (the test runner is minutes on its own) out of the critical path.
  const toInstall = [], toLink = [];
  for (const name of absent) {
    const repoCopy = repoModules ? path.join(repoModules, ...name.split('/')) : '';
    let repoVersion = '';
    try { repoVersion = JSON.parse(fs.readFileSync(path.join(repoCopy, 'package.json'), 'utf8')).version; }
    catch { repoVersion = ''; }
    if (repoVersion && repoVersion === String(declared[name]).replace(/^[\^~]/, '')) toLink.push(name);
    else toInstall.push(`${name}@${String(declared[name]).replace(/^[\^~]/, '')}`);
  }

  if (toInstall.length) {
    execFileSync(process.env.EPAM_NPM_BIN || 'npm',
      ['install', '--no-audit', '--no-fund', ...toInstall],
      { cwd: depsDir, stdio: 'inherit' });
  }
  // Links go in AFTER the install, because npm prunes what it does not manage.
  for (const name of toLink) {
    const target = path.join(modules, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.symlinkSync(path.join(repoModules, ...name.split('/')), target); } catch { /* present */ }
    const bin = path.join(repoModules, '.bin', name);
    if (fs.existsSync(bin)) {
      fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
      try { fs.symlinkSync(bin, path.join(modules, '.bin', name)); } catch { /* present */ }
    }
  }
  return { installed: toInstall, linked: toLink, alreadyComplete: false };
}

function main() {
  const repoModules = arg('--repo-node-modules', path.join(__dirname, '..', '..', 'node_modules'));
  const depsDir = arg('--deps', path.join(FIXTURE, '.deps'));

  // Provisioning needs no estate — it prepares the modules a later build will link.

  // Provisioning is a STEP, not something a pipeline run pays for.
  if (process.argv.includes('--provision')) {
    const r = provisionDeps(depsDir, repoModules);
    process.stdout.write(JSON.stringify({ depsDir, ...r }, null, 2) + '\n');
    return;
  }
  const root = arg('--root');
  if (!root) { console.error('mock-estate-seed: --root <dir> is required'); process.exit(2); }
  const sharedModules = arg('--node-modules', path.join(depsDir, 'node_modules'));
  fs.mkdirSync(root, { recursive: true });

  const names = fs.readdirSync(VARIANTS, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!names.length) { console.error('mock-estate-seed: no variants found'); process.exit(2); }

  const staging = path.join(path.dirname(root), `${path.basename(root)}-build`);
  fs.mkdirSync(staging, { recursive: true });
  const reconciled = reconcileModules(sharedModules, repoModules);
  const built = names.map((n) => buildCodeline(root, staging, n, sharedModules));
  process.stdout.write(JSON.stringify(
    { codelines: names, paths: built, linkedFromRepo: reconciled.linked, unresolved: reconciled.missing },
    null, 2) + '\n');
}

main();
