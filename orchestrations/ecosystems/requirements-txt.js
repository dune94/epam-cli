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
    installCommand: () => 'pip install -r requirements.txt',
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
    stack: 'python',
    installDir: null,
    deps: (text) => text.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
      .map((l) => l.split(/[<>=!~[;]/)[0].trim())
      .filter(Boolean),
};
