/**
 * ECOSYSTEM PROVIDER — discovered at run time, never enumerated by the engine.
 *
 * Moved verbatim out of lib/ecosystem-registry.js on 2026-08-20. That file was a table of the stacks the
 * engine KNEW: onboarding a stack meant editing the engine, which is the definition of a fact the
 * pipeline should not hold. The parsers are real code (JSON for a package manifest, section
 * matching for TOML, line rules for a requirements file), so they move as code — one provider per
 * ecosystem, loaded from a directory at run time.
 *
 * Adding an ecosystem is a NEW FILE here and nothing else. Nothing in the engine names a stack.
 */
module.exports = {
  // WHAT A CODELINE OF THIS ECOSYSTEM DECLARES ABOUT ITSELF.
  //
  // These three blocks were heredocs inside run-agent-orchestration.sh, written into EVERY client
  // worktree that lacked a .epam/ -- so a repository the engine had never inspected was handed a
  // document saying it is TypeScript with vitest, and the seventeen scripts that read
  // dependency-check.json as that codeline's own declaration then consulted it as ground truth.
  //
  // They are facts about THIS ecosystem, so they live with it. manifestFile, vendorDirs and
  // installCommand are NOT repeated here -- the registry already answers those, and a second
  // spelling is the one that drifts. requiredDevDependencies (typescript, @types/node, vitest,
  // tsx) is gone entirely: requiring a toolchain of somebody else's codebase is not a fact
  // about it.
  codelineManifests: {
    "dependencyCheck": {
      "manifestKeys": [
        "dependencies",
        "devDependencies"
      ],
      "scanFileExtensions": [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs"
      ],
      "importPattern": "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
      "ignorePackages": [
        "assert",
        "buffer",
        "child_process",
        "cluster",
        "crypto",
        "dgram",
        "dns",
        "domain",
        "events",
        "fs",
        "http",
        "http2",
        "https",
        "net",
        "os",
        "path",
        "perf_hooks",
        "process",
        "punycode",
        "querystring",
        "readline",
        "repl",
        "stream",
        "string_decoder",
        "timers",
        "tls",
        "tty",
        "url",
        "util",
        "v8",
        "vm",
        "worker_threads",
        "zlib",
        "node:assert",
        "node:buffer",
        "node:child_process",
        "node:crypto",
        "node:events",
        "node:fs",
        "node:http",
        "node:https",
        "node:net",
        "node:os",
        "node:path",
        "node:process",
        "node:stream",
        "node:url",
        "node:util",
        "node:vm",
        "node:zlib"
      ]
    },
    "contractGeneration": {
      "language": "typescript",
      "sourceExtensions": [
        ".ts"
      ],
      "excludePattern": "\\.(test|spec)\\.ts$",
      "interfacePattern": "export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}",
      "classPattern": "export\\s+class\\s+(\\w+)\\s*(?:extends\\s+\\w+\\s*)?\\{",
      "ctorPattern": "constructor\\s*\\(([^)]*)\\)",
      "methodPattern": "^\\s*(?:public\\s+|private\\s+|protected\\s+)?(async\\s+)?(\\w+)\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{;]+))?\\s*\\{",
      "interfaceRenderTemplate": "export interface {{name}} {{{body}}}",
      "classDeclarationTemplate": "export class {{className}} {\n  constructor({{ctorParams}});\n{{methodSignatures}}\n}",
      "methodSignatureTemplate": "  {{asyncPrefix}}{{methodName}}({{params}}){{returnAnnotation}};",
      "asyncPrefixKeyword": "async ",
      "returnAnnotationPrefix": ": ",
      "mockFactoryTemplate": "vi.mock('<import-path-to-{{className}}>', () => ({\n  {{className}}: vi.fn().mockImplementation(() => ({\n{{methodMocks}}\n  })),\n}));",
      "mockMethodTemplateSync": "    {{methodName}}: vi.fn(),",
      "mockMethodTemplateAsync": "    {{methodName}}: vi.fn().mockResolvedValue(undefined),",
      "testFileExtensions": [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs"
      ],
      "testFilePattern": "\\.(test|spec)\\.[a-zA-Z0-9]+$",
      "mockFactoryStartPattern": "vi\\.mock\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\{",
      "mockClassPattern": "(\\w+)\\s*:\\s*vi\\.fn\\(\\)\\.mockImplementation\\(\\(\\)\\s*=>\\s*\\(\\{",
      "mockedMethodPattern": "^\\s*(\\w+)\\s*:",
      "testFileAgentRole": "test-engineer"
    },
    "knownFixes": [
      {
        "id": "vitest-pass-with-no-tests",
        "symptomPattern": "(?:vitest|test).*(?:no test files|zero test files).*exit|exit.*1.*(?:no|zero) test files|passWithNoTests",
        "targetFile": "vitest.config.ts",
        "checkPattern": "passWithNoTests",
        "insertAfterPattern": "test:\\s*\\{",
        "insertText": "\n    passWithNoTests: true,"
      }
    ]
  },

  // WHERE THIS PROVIDER SITS when a repository carries more than one manifest. Consumers take the
  // FIRST match, so this is behaviour, not decoration. Declared here — by the ecosystem itself —
  // rather than ranked by the engine, which is the whole point of the provider split.
  precedence: 10,
    file: 'package.json',
    // FILES A WRITER MUST NEVER EDIT — the scaffold/infrastructure this ecosystem is configured
    // by. Prompts used to name these directly ("NEVER modify package.json, tsconfig.json,
    // vitest.config.ts"), which told every agent on every project that the world is Node.
    protectedFiles: ['package.json', 'tsconfig.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
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
    // HOW THIS ECOSYSTEM ADDS ONE NEW DEPENDENCY.
    //
    // installCommand provisions what the manifest ALREADY declares; it cannot add anything. The
    // writer directive needs the other command — the one that writes the manifest and the lockfile
    // together — and telling an agent to run a bare provisioning install to add a package is how
    // AMSD-2041 ended up with a manifest entry no lockfile resolved. `{package}` is substituted
    // by the caller.
    addCommand: (manager) => (manager === 'yarn' || manager === 'pnpm' ? `${manager} add {package}` : 'npm install {package}'),
    // DOES THE LOCKFILE RESOLVE THIS DEPENDENCY?
    //
    // A manifest states an intent; the lockfile is the only record of what a clean checkout will
    // actually install. Live metrolinx AMSD-2041 added a package to package.json and to nothing
    // else, and every check the pipeline owns passed anyway because a node_modules left over from
    // an earlier run already contained it. `npm ci` on that branch fails.
    //
    // Returns true/false, or NULL when this ecosystem cannot answer for the lockfile it was
    // handed — which the caller must read as "cannot prove", never as "declared".
    lockDeclares: (lockText, name) => {
      // npm and npm-shrinkwrap are JSON. pnpm and yarn lockfiles are not, and this returns null
      // for them rather than guessing at a format it does not parse.
      let doc;
      try { doc = JSON.parse(lockText); } catch { return null; }
      const inPackages = Object.keys(doc.packages || {}).some(
        (k) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`),
      );
      if (inPackages) return true;
      // lockfileVersion 1 carries a nested `dependencies` tree instead of a flat `packages` map.
      const walk = (node) => Object.entries(node || {}).some(
        ([k, v]) => k === name || walk(v && v.dependencies),
      );
      return walk(doc.dependencies);
    },
    // The name a manifest gives itself, used to resolve one repository's dependency to another
    // repository in the same estate.
    selfName: (text) => JSON.parse(text).name || '',
    // WHAT COMMAND RUNS THIS PROJECT'S OWN TESTS, taken from what the project declares rather
    // than from a runner name. Returns '' when it declares none, which the caller reads as
    // 'nothing to run' — never as 'the tests passed'.
    testCommand: (text, manager) => ((JSON.parse(text).scripts || {}).test ? ((manager || 'npm') + ' test') : ''),
    // HOW THIS ECOSYSTEM RUNS SPECIFIC TEST FILES.
    //
    // The bug-reproduction gate must execute ONE test — the story's new reproducing test — against
    // the pre-fix and post-fix trees. That is genuinely stack-specific, and the gate carried its
    // own answer: it probed node_modules/.bin/vitest, then jest, then `npm test`, and on anything
    // else logged "no supported test runner found" and EXITED 0. So the hard gate that blocks a
    // change shipping no working test passed vacuously on every non-Node codeline — and both Step
    // 3.54 and Step 3.545 defer their findings to it.
    //
    // Receives the resolved run command and the file list; returns '' when this ecosystem has no
    // way to target individual files, which the caller must read as "cannot prove", never as "passed".
    testFileCommand: (run, files) => (run ? `${run}${/ test$/.test(run) ? ' --' : ''} ${files.join(' ')}` : ''),
    // HOW THIS ECOSYSTEM INSTALLS ITS DEPENDENCIES.
    //
    // The unit-test gate ran `npm install` unconditionally and then required
    // node_modules/.bin/vitest to exist. Returns '' when this ecosystem vendors nothing in-repo
    // and therefore has nothing to install before its tests can run.
    // CLEAN IS OPT-IN, and what "clean" means is this ecosystem's to say.
  //
  // `npm ci` DELETES node_modules before installing. On 2026-07-28 a repair selected it merely
  // because a lockfile existed, wiped a working 1,530-package install, hit a 401 on a private
  // dependency, aborted, and left the codeline EMPTY. The engine decides WHETHER a clean install
  // was asked for; the provider decides what command that is.
  installCommand: (manager, opts) => ((opts && opts.clean)
    ? `${manager || 'npm'} ci`
    : `${manager || 'npm'} install --no-audit --no-fund`),
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
};
