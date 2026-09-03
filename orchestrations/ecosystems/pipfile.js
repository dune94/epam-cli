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
  },
  stack: 'python',
  installDir: '.venv',
  protectedFiles: ['Pipfile', 'Pipfile.lock'],
  artifactDirs: ['.venv', '__pycache__', '.pytest_cache', '.mypy_cache'],
  lockfiles: { 'Pipfile.lock': 'pipenv' },
  installCommand: () => 'pipenv install --dev',
  addCommand: () => 'pipenv install {package}',
  testCommand: () => '',
  testFileCommand: (run, files) => (run ? `${run} ${files.join(' ')}` : ''),
  deps: (text) => [...text.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*/gm)].map((m) => m[1]),
};
