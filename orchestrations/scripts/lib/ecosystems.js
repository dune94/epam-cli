/**
 * THE ECOSYSTEMS THIS ENGINE KNOWS — the one table.
 *
 * An ecosystem is identified by the manifest file a repository carries. Three things are wanted
 * from that fact and each used to be answered somewhere different:
 *
 *   stack       what to call it, reported by the repo scan into the discovery agent's manifest
 *   installDir  where its dependencies are vendored, or null when nothing is vendored in-repo
 *   deps        what the repository declares it depends on
 *
 * TWO TABLES EXISTED AND HAD ALREADY DRIFTED. codeline-structure.js knew six manifest files;
 * codeline-discovery.js's repo scan knew three and labelled everything else `unknown` — on the one
 * input the discovery agent uses to choose which client repository gets written to. A Rust or Ruby
 * repository arrived at that decision described as nothing in particular.
 *
 * Adding an ecosystem is an edit HERE and nowhere else. Nothing in this file names a client, a
 * product, or an industry noun, and no scanner may write a manifest filename of its own again —
 * a test enforces that, because a second table is exactly how the first drift happened.
 *
 * `EPAM_CODELINE_MANIFESTS` still extends the list at runtime ("manifest:installDir,manifest:")
 * for an ecosystem this file has not met yet.
 */
const MANIFESTS = [
  {
    file: 'package.json',
    // WHAT THIS ECOSYSTEM LEAVES BEHIND. Never staged into a client repository and never reported
    // as uncommitted agent work. Was three hand-written lists in two shell files, naming
    // node_modules, build and .next between them — one ecosystem — so a Rust codeline staged
    // target/ into the customer's repo when it was not gitignored, and the health check reported
    // the same tree as thousands of files of agent output and failed the phase.
    //
    // THE BIAS IS ONE-DIRECTIONAL: a directory wrongly excluded loses real agent work SILENTLY;
    // one wrongly included shows up in a diff a human reads. So Go's vendor/ and bin/ are absent
    // deliberately — vendor/ is committed by convention and bin/ is tracked in plenty of repos.
    artifactDirs: ['node_modules', 'build', 'dist', '.next', '.nuxt', '.turbo', 'coverage', '.parcel-cache'],
    stack: 'node',
    installDir: 'node_modules',
    // Which tool installs it, decided by the lockfile the repository carries. First match wins.
    lockfiles: { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm' },
    // The name a manifest gives itself, used to resolve one repository's dependency to another
    // repository in the same estate.
    selfName: (text) => JSON.parse(text).name || '',
    // WHAT COMMAND RUNS THIS PROJECT'S OWN TESTS, taken from what the project declares rather
    // than from a runner name. Returns '' when it declares none, which the caller reads as
    // 'nothing to run' — never as 'the tests passed'.
    testCommand: (text, manager) => ((JSON.parse(text).scripts || {}).test ? ((manager || 'npm') + ' test') : ''),
    deps: (text) => {
      const pkg = JSON.parse(text);
      return Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    },
    // The repo scan also reads a display name and a description out of this one. Kept with the
    // ecosystem that defines the fields rather than in the scanner that happens to want them.
    describe: (text) => {
      const pkg = JSON.parse(text);
      return { packageName: pkg.name || '', description: pkg.description || '' };
    },
  },
  {
    file: 'pyproject.toml',
    // WHAT THIS ECOSYSTEM LEAVES BEHIND. Never staged into a client repository and never reported
    // as uncommitted agent work. Was three hand-written lists in two shell files, naming
    // node_modules, build and .next between them — one ecosystem — so a Rust codeline staged
    // target/ into the customer's repo when it was not gitignored, and the health check reported
    // the same tree as thousands of files of agent output and failed the phase.
    //
    // THE BIAS IS ONE-DIRECTIONAL: a directory wrongly excluded loses real agent work SILENTLY;
    // one wrongly included shows up in a diff a human reads. So Go's vendor/ and bin/ are absent
    // deliberately — vendor/ is committed by convention and bin/ is tracked in plenty of repos.
    artifactDirs: ['__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache', 'build', 'dist', '.eggs'],
    stack: 'python',
    installDir: null, // a virtualenv commonly lives outside the repo
    lockfiles: { 'poetry.lock': 'poetry', 'uv.lock': 'uv', 'pdm.lock': 'pdm' },
    testCommand: (text) => (/\[tool\.pytest/.test(text) ? 'pytest' : ''),
    selfName: (text) => ((text.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1] || ''),
    deps: (text) => {
      const out = [];
      // [project] dependencies = ["a", "b>=1"]  and poetry's [tool.poetry.dependencies]
      //
      // Match a COMPLETE quoted string, then strip the version specifier. An earlier version
      // matched from an opening quote to the next delimiter, which also matched the `", `
      // BETWEEN two entries and yielded a dependency literally named ",". That junk name
      // normalised to the empty string, and "anything".includes("") is true in JS — so one
      // malformed entry matched every ticket term and handed a repo a perfect structural score.
      const arr = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (arr) {
        for (const m of arr[1].matchAll(/["']([^"']+)["']/g)) {
          const name = m[1].split(/[<>=!~^;[\s]/)[0].trim();
          if (name) out.push(name);
        }
      }
      const poetry = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/);
      if (poetry) for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)) out.push(m[1]);
      return out;
    },
  },
  {
    file: 'requirements.txt',
    // WHAT THIS ECOSYSTEM LEAVES BEHIND. Never staged into a client repository and never reported
    // as uncommitted agent work. Was three hand-written lists in two shell files, naming
    // node_modules, build and .next between them — one ecosystem — so a Rust codeline staged
    // target/ into the customer's repo when it was not gitignored, and the health check reported
    // the same tree as thousands of files of agent output and failed the phase.
    //
    // THE BIAS IS ONE-DIRECTIONAL: a directory wrongly excluded loses real agent work SILENTLY;
    // one wrongly included shows up in a diff a human reads. So Go's vendor/ and bin/ are absent
    // deliberately — vendor/ is committed by convention and bin/ is tracked in plenty of repos.
    artifactDirs: ['__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache'],
    stack: 'python',
    installDir: null,
    deps: (text) => text.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
      .map((l) => l.split(/[<>=!~[;]/)[0].trim())
      .filter(Boolean),
  },
  {
    file: 'go.mod',
    // WHAT THIS ECOSYSTEM LEAVES BEHIND. Never staged into a client repository and never reported
    // as uncommitted agent work. Was three hand-written lists in two shell files, naming
    // node_modules, build and .next between them — one ecosystem — so a Rust codeline staged
    // target/ into the customer's repo when it was not gitignored, and the health check reported
    // the same tree as thousands of files of agent output and failed the phase.
    //
    // THE BIAS IS ONE-DIRECTIONAL: a directory wrongly excluded loses real agent work SILENTLY;
    // one wrongly included shows up in a diff a human reads. So Go's vendor/ and bin/ are absent
    // deliberately — vendor/ is committed by convention and bin/ is tracked in plenty of repos.
    artifactDirs: [],
    stack: 'go',
    installDir: null, // module cache is global, not in-repo
    lockfiles: { 'go.sum': 'go' },
    testCommand: () => 'go test ./...',
    selfName: (text) => ((text.match(/^module\s+(\S+)/m) || [])[1] || ''),
    deps: (text) => [...text.matchAll(/^\s+([\w.\-/]+)\s+v[\d.]/gm)].map((m) => m[1]),
  },
  {
    file: 'Cargo.toml',
    // WHAT THIS ECOSYSTEM LEAVES BEHIND. Never staged into a client repository and never reported
    // as uncommitted agent work. Was three hand-written lists in two shell files, naming
    // node_modules, build and .next between them — one ecosystem — so a Rust codeline staged
    // target/ into the customer's repo when it was not gitignored, and the health check reported
    // the same tree as thousands of files of agent output and failed the phase.
    //
    // THE BIAS IS ONE-DIRECTIONAL: a directory wrongly excluded loses real agent work SILENTLY;
    // one wrongly included shows up in a diff a human reads. So Go's vendor/ and bin/ are absent
    // deliberately — vendor/ is committed by convention and bin/ is tracked in plenty of repos.
    artifactDirs: ['target'],
    stack: 'rust',
    installDir: null,
    lockfiles: { 'Cargo.lock': 'cargo' },
    testCommand: () => 'cargo test',
    selfName: (text) => ((text.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1] || ''),
    deps: (text) => {
      const sec = text.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
      return sec ? [...sec[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]) : [];
    },
  },
  {
    file: 'Gemfile',
    // WHAT THIS ECOSYSTEM LEAVES BEHIND. Never staged into a client repository and never reported
    // as uncommitted agent work. Was three hand-written lists in two shell files, naming
    // node_modules, build and .next between them — one ecosystem — so a Rust codeline staged
    // target/ into the customer's repo when it was not gitignored, and the health check reported
    // the same tree as thousands of files of agent output and failed the phase.
    //
    // THE BIAS IS ONE-DIRECTIONAL: a directory wrongly excluded loses real agent work SILENTLY;
    // one wrongly included shows up in a diff a human reads. So Go's vendor/ and bin/ are absent
    // deliberately — vendor/ is committed by convention and bin/ is tracked in plenty of repos.
    artifactDirs: ['.bundle'],
    stack: 'ruby',
    installDir: null,
    lockfiles: { 'Gemfile.lock': 'bundle' },
    testCommand: (text) => (/rspec|minitest/.test(text) ? 'bundle exec rake test' : ''),
    deps: (text) => [...text.matchAll(/^\s*gem\s+['"]([^'"]+)/gm)].map((m) => m[1]),
  },
];

/** Extra ecosystems without editing this file: "manifest:installDir,manifest:" */
function extraManifests(env) {
  const raw = (env && env.EPAM_CODELINE_MANIFESTS) || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [file, installDir] = pair.split(':');
    // No `stack` is declared for a runtime addition, so the scan reports the manifest filename
    // itself. Saying which file was found beats saying `unknown`, which is what an
    // engine-unknown ecosystem used to become.
    return { file, stack: file, installDir: installDir || null, artifactDirs: installDir ? [installDir] : [], deps: () => [] };
  });
}

function allManifests(env = process.env) {
  return [...MANIFESTS, ...extraManifests(env)];
}

/**
 * EVERY DIRECTORY ANY KNOWN ECOSYSTEM LEAVES BEHIND, deduped.
 *
 * The union, not the detected ecosystem's — a monorepo mixes stacks, and excluding a directory a
 * repository does not have costs nothing. Editor and OS droppings are not ecosystem facts and are
 * not here; they come from config/repo-artifacts.json.
 */
function allArtifactDirs() {
  const seen = new Set();
  for (const eco of allManifests()) for (const d of eco.artifactDirs || []) seen.add(d);
  return [...seen];
}

module.exports = { MANIFESTS, allManifests, extraManifests, allArtifactDirs };
