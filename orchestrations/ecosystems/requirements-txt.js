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
  // WHERE THIS PROVIDER SITS when a repository carries more than one manifest. Consumers take the
  // FIRST match, so this is behaviour, not decoration. Declared here — by the ecosystem itself —
  // rather than ranked by the engine, which is the whole point of the provider split.
  precedence: 30,
    file: 'requirements.txt',
    // FILES A WRITER MUST NEVER EDIT — the scaffold/infrastructure this ecosystem is configured
    // by. Prompts used to name these directly ("NEVER modify package.json, tsconfig.json,
    // vitest.config.ts"), which told every agent on every project that the world is Node.
    protectedFiles: ['requirements.txt', 'setup.cfg'],
    // HOW THIS ECOSYSTEM INSTALLS ITS DEPENDENCIES.
    //
    // The unit-test gate ran `npm install` unconditionally and then required
    // node_modules/.bin/vitest to exist. Returns '' when this ecosystem vendors nothing in-repo
    // and therefore has nothing to install before its tests can run.
    // PROVISIONING CREATES THE ENVIRONMENT IT INSTALLS INTO. A requirements file installs into
    // whatever interpreter runs pip; a fresh worktree has none of its own, and a system pip
    // refuses (externally-managed-environment) or pollutes the host. The environment is this
    // ecosystem's, declared here — run 20260915T101555Z's verification worktree had no
    // interpreter at all and every pytest exited 2 while the engine ran a Node-shaped install.
    installCommand: () => 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
    // WHERE COMMANDS RUN. The engine exports these when it runs any command in this codeline:
    // PATH entries are codeline-relative directories put in front of PATH; other keys are set
    // verbatim. So `pytest` resolves to the environment's own, not the host's.
    runEnvironment: { PATH: ['.venv/bin'], VIRTUAL_ENV: '.venv' },
    // FILES THAT ARE COMPLETE WHEN EMPTY. A package marker carries no content by design; the
    // deliverable check demands a non-empty file for everything else, and an empty __init__.py
    // read as "missing" through every attempt of a story that had written it (regintel
    // 20260916T200108Z, 2026-09-17). Matched by basename.
    emptyDeliverables: ['__init__.py'],
    // HOW THIS ECOSYSTEM ADDS ONE NEW DEPENDENCY: installed with pip and declared by a line in the
    // manifest — the project's dependency declaration (dependency-check.json installCommand) is
    // this, so the two cannot disagree.
    addCommand: () => 'pip install {package}',
    // A requirements.txt project declares no test command of its own, so it declares no way to
    // run one file either. '' means "cannot prove", which the bug-reproduction gate must report
    // rather than treat as a pass.
    testFileCommand: (run, files) => (run ? `${run} ${files.join(' ')}` : ''),
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
      importPattern: "^\\s*(?:from\\s+([A-Za-z_][\\w]*)|import\\s+([A-Za-z_][\\w]*))",
      // THE RUNTIME'S OWN MODULES, ASKED OF THE RUNTIME. `from __future__ import annotations` was
      // reported as an undeclared import and failed a story through the ladder (regintel
      // 20260916T200108Z, 2026-09-17): the scan knew declared, internal and vendored, never
      // built-in. The interpreter lists its standard library; nothing is spelled here.
      builtinModulesCommand: "python3 -c 'import sys; print(\"\\n\".join(sorted(sys.stdlib_module_names)))'",
    },
    // HOW THIS ECOSYSTEM'S TESTS ARE TOLD FROM ITS SOURCES. pytest's own collection rule
    // (test_*.py / *_test.py). Without it the change classifier and the test gates read every
    // .py file as source, and a codeline that added a test was told it added none.
    contractGeneration: {
      language: 'python',
      sourceExtensions: ['.py'],
      excludePattern: '(^|/)(test_[^/]*|[^/]*_test)\\.py$',
      testFilePattern: '(^|/)(test_[^/]*|[^/]*_test)\\.py$',
      // One path this ecosystem itself reads as a test — declared beside the pattern so a test of the
      // pattern needs no list of conventions.
      exampleTestPath: 'tests/test_x.py',
    },
  },
  stack: 'python',
  // THE CHECKS THIS ECOSYSTEM PROVIDES WITHOUT A DEPENDENCY: a syntax-level type check the standard
  // library runs, with the pattern its failures print. Read by the verification plugin when the
  // codeline declares none of its own — a check nobody could run failed every writer attempt.
  verification: {
    typecheck: {
      command: "python3 -m compileall -q -x '(^|/)(\\.venv|venv|\\.tox|node_modules)(/|$)' .",
      failurePattern: 'File "([^"]+)", line (\\d+)',
      failureIdentity: '{1}:{2}',
    },
  },
  // WHAT A STAND-IN DELIVERABLE HOLDS, so a £0 rehearsal's writer can land files the gates will
  // run: a manifest that names the test runner, a test that passes, a source module that imports.
  standIn: {
    manifest: 'pytest\n',
    test: 'def test_stand_in():\n    assert True\n',
    source: '"""stand-in module written by the rehearsal"""\n',
  },
  // A requirements.txt project runs its suite with whatever test runner it depends on. pytest is
  // the one this provider recognises: listed in requirements.txt, the suite is `pytest`; absent,
  // '' — "cannot prove", never a guess. The 2026-09-12 greenfield project (Python, FastAPI,
  // pytest, requirements.txt) had every gate reading "no test command" because only package.json
  // scripts were ever consulted.
  testCommand: (text) => (module.exports.deps(String(text || '')).some((d) => d.toLowerCase() === 'pytest') ? 'pytest' : ''),
    installDir: '.venv',
    deps: (text) => text.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
      .map((l) => l.split(/[<>=!~[;]/)[0].trim())
      .filter(Boolean),
};
