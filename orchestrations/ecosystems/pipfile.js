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
