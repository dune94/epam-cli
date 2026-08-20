/**
 * ECOSYSTEM PROVIDER — Composer / PHP.
 *
 * Was an installer branch with no provider; see pipfile.js.
 */
module.exports = {
  precedence: 80,
  file: 'composer.json',
  stack: 'php',
  installDir: 'vendor',
  protectedFiles: ['composer.json', 'composer.lock'],
  // artifactDirs IS DELIBERATELY EMPTY, even though composer vendors into vendor/.
  //
  // allArtifactDirs() is a UNION across every provider and feeds the repo exclusion list, so a name
  // one ecosystem calls an artifact is excluded for ALL of them. `vendor/` is a build artifact in
  // PHP and COMMITTED SOURCE in Go — go-mod.js says so explicitly and omits it for that reason.
  // Declaring it here silently discarded committed Go work from the staging set.
  //
  // installDir stays: that is per-resolved-ecosystem (the install shrink-check), never a union.
  artifactDirs: [],
  lockfiles: { 'composer.lock': 'composer' },
  installCommand: () => 'composer install --no-interaction',
  addCommand: () => 'composer require {package}',
  selfName: (text) => { try { return JSON.parse(text).name || ''; } catch { return ''; } },
  testCommand: () => '',
  testFileCommand: (run, files) => (run ? `${run} ${files.join(' ')}` : ''),
  deps: (text) => { try { const j = JSON.parse(text); return Object.keys({ ...(j.require || {}), ...(j['require-dev'] || {}) }); } catch { return []; } },
};
