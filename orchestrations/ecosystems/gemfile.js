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
  precedence: 60,
    file: 'Gemfile',
    // FILES A WRITER MUST NEVER EDIT — the scaffold/infrastructure this ecosystem is configured
    // by. Prompts used to name these directly ("NEVER modify package.json, tsconfig.json,
    // vitest.config.ts"), which told every agent on every project that the world is Node.
    protectedFiles: ['Gemfile', 'Gemfile.lock', '.rubocop.yml'],
    // HOW THIS ECOSYSTEM INSTALLS ITS DEPENDENCIES.
    //
    // The unit-test gate ran `npm install` unconditionally and then required
    // node_modules/.bin/vitest to exist. Returns '' when this ecosystem vendors nothing in-repo
    // and therefore has nothing to install before its tests can run.
    installCommand: () => 'bundle install',
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
    // HOW THIS ECOSYSTEM ADDS ONE NEW DEPENDENCY.
    //
    // installCommand provisions what the manifest ALREADY declares; it cannot add anything. The
    // writer directive needs the other command — the one that writes the manifest and the lockfile
    // together — and telling an agent to run a bare provisioning install to add a package is how
    // AMSD-2041 ended up with a manifest entry no lockfile resolved. `{package}` is substituted
    // by the caller.
    addCommand: () => 'bundle add {package}',
    // DOES THE LOCKFILE RESOLVE THIS DEPENDENCY?
    //
    // A manifest states an intent; the lockfile is the only record of what a clean checkout will
    // actually install. Live metrolinx AMSD-2041 added a package to package.json and to nothing
    // else, and every check the pipeline owns passed anyway because a node_modules left over from
    // an earlier run already contained it. `npm ci` on that branch fails.
    //
    // Returns true/false, or NULL when this ecosystem cannot answer for the lockfile it was
    // handed — which the caller must read as "cannot prove", never as "declared".
    // Gemfile.lock indents each resolved gem under specs:, name first then a parenthesised version.
    lockDeclares: (lockText, name) => new RegExp(
      `^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'm',
    ).test(lockText),
    testCommand: (text) => (/rspec|minitest/.test(text) ? 'bundle exec rake test' : ''),
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
    testFileCommand: (run, files) => (run ? `${run} ${files.join(' ')}` : ''),
    deps: (text) => [...text.matchAll(/^\s*gem\s+['"]([^'"]+)/gm)].map((m) => m[1]),
};
