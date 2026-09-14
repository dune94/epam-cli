/**
 * ECOSYSTEM PROVIDER — Composer / PHP.
 *
 * Was an installer branch with no provider; see pipfile.js.
 */
module.exports = {
  precedence: 80,
  file: 'composer.json',
  // THE EXTENSIONS THIS ECOSYSTEM SOURCE IS WRITTEN IN.
  //
  // Only package-json.js declared these, so lib/handlers/testable-source.js resolved an EMPTY
  // set for every other ecosystem and found no file testable on a Python, Go, Rust, Ruby, Java
  // or PHP codeline. brownfield-repro-test-writer.sh then reported "nothing sensible to test" —
  // indistinguishable from a correct decision — so bug-reproduction tests silently never
  // happened outside Node. That is the exact Node-only defect testable-source.js was written to
  // remove, surviving one layer further down because the DATA it reads was never filled in.
  codelineManifests: {
    dependencyCheck: {
      scanFileExtensions: [".php"],
    },
    // HOW THIS ECOSYSTEM'S TESTS ARE TOLD FROM ITS SOURCES — read by the change classifier, the
    // test gates and the rehearsal's stand-in writer (which must write a test into a test file
    // and a module into a module).
    contractGeneration: {
      language: 'php',
      sourceExtensions: ['.php'],
      excludePattern: '(^|/)(tests?)/.*Test\\.php$',
      testFilePattern: '(^|/)(tests?)/.*Test\\.php$',
      // One path this ecosystem itself reads as a test — declared beside the pattern so a test of the
      // pattern needs no list of conventions.
      exampleTestPath: 'tests/XTest.php',
    },
  },
  // WHAT A STAND-IN DELIVERABLE HOLDS, so a £0 rehearsal's writer can land files the gates will
  // run: a manifest that names the test runner, a test that passes, a source file that compiles.
  // A function receives the deliverable's path where the content must agree with it.
  standIn: {
    manifest: JSON.stringify({ name: 'stand-in/stand-in', 'require-dev': { 'phpunit/phpunit': '^10' }, scripts: { test: 'phpunit tests' } }, null, 2) + '\n',
    test: (f) => `<?php\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class ${require('path').basename(f, '.php')} extends TestCase\n{\n    public function testStandIn(): void\n    {\n        $this->assertTrue(true);\n    }\n}\n`,
    source: '<?php\n// stand-in module written by the rehearsal\n',
  },
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
  // The project's own `scripts.test`, run the way composer runs it; absent, '' — never a guess.
  testCommand: (text) => { try { return (JSON.parse(text).scripts || {}).test ? 'composer test' : ''; } catch { return ''; } },
  testFileCommand: (run, files) => (run ? `${run} ${files.join(' ')}` : ''),
  deps: (text) => { try { const j = JSON.parse(text); return Object.keys({ ...(j.require || {}), ...(j['require-dev'] || {}) }); } catch { return []; } },
};
