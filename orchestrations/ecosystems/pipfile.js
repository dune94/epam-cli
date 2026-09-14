/**
 * ECOSYSTEM PROVIDER — Pipfile / pipenv.
 *
 * This ecosystem existed only as a branch in run-agent-orchestration.sh's installer if-chain and
 * had no provider, so every other question about it — what it vendors, what a writer must not
 * touch, what it leaves behind — was answered "unknown".
 */
module.exports = {
  precedence: 15,
  file: 'Pipfile',
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
      scanFileExtensions: [".py"],
    },
    // HOW THIS ECOSYSTEM'S TESTS ARE TOLD FROM ITS SOURCES — read by the change classifier, the
    // test gates and the rehearsal's stand-in writer (which must write a test into a test file
    // and a module into a module).
    contractGeneration: {
      language: 'python',
      sourceExtensions: ['.py'],
      excludePattern: '(^|/)(test_[^/]*|[^/]*_test)\\.py$',
      testFilePattern: '(^|/)(test_[^/]*|[^/]*_test)\\.py$',
    },
  },
  // WHAT A STAND-IN DELIVERABLE HOLDS, so a £0 rehearsal's writer can land files the gates will
  // run: a manifest that names the test runner, a test that passes, a source file that compiles.
  // A function receives the deliverable's path where the content must agree with it.
  standIn: {
    manifest: '[[source]]\nurl = "https://pypi.org/simple"\nverify_ssl = true\nname = "pypi"\n\n[packages]\n\n[dev-packages]\npytest = "*"\n',
    test: 'def test_stand_in():\n    assert True\n',
    source: '"""stand-in module written by the rehearsal"""\n',
  },
  stack: 'python',
  installDir: '.venv',
  protectedFiles: ['Pipfile', 'Pipfile.lock'],
  artifactDirs: ['.venv', '__pycache__', '.pytest_cache', '.mypy_cache'],
  lockfiles: { 'Pipfile.lock': 'pipenv' },
  installCommand: () => 'pipenv install --dev',
  addCommand: () => 'pipenv install {package}',
  // pytest listed under [dev-packages] or [packages] runs as `pipenv run pytest`; absent, '' —
  // "cannot prove", never a guess (the same rule requirements-txt.js applies to its own list).
  testCommand: (text) => (/^\s*pytest\s*=/m.test(String(text || '')) ? 'pipenv run pytest' : ''),
  testFileCommand: (run, files) => (run ? `${run} ${files.join(' ')}` : ''),
  deps: (text) => [...text.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*/gm)].map((m) => m[1]),
};
