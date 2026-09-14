/**
 * ECOSYSTEM PROVIDER — Gradle.
 *
 * Was an installer branch with no provider; see pipfile.js. The engine's branch also matched
 * build.gradle.kts, which is the same ecosystem — declared here as an extra manifest.
 */
module.exports = {
  precedence: 75,
  file: 'build.gradle',
  alsoMatches: ['build.gradle.kts'],
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
      scanFileExtensions: [".java",".kt"],
    },
    // HOW THIS ECOSYSTEM'S TESTS ARE TOLD FROM ITS SOURCES — read by the change classifier, the
    // test gates and the rehearsal's stand-in writer (which must write a test into a test file
    // and a module into a module).
    contractGeneration: {
      language: 'java',
      sourceExtensions: ['.java', '.kt'],
      excludePattern: '(^|/)src/test/.*\\.(java|kt)$',
      testFilePattern: '(^|/)src/test/.*\\.(java|kt)$',
    },
  },
  // WHAT A STAND-IN DELIVERABLE HOLDS, so a £0 rehearsal's writer can land files the gates will
  // run: a manifest that names the test runner, a test that passes, a source file that compiles.
  // A function receives the deliverable's path where the content must agree with it.
  standIn: {
    manifest: "plugins { id 'java' }\n\nrepositories { mavenCentral() }\n\ndependencies { testImplementation 'junit:junit:4.13.2' }\n",
    test: (f) => { const p = require('path'); const cls = p.basename(f).replace(/\.(java|kt)$/, ''); const m = f.replace(/\\/g, '/').match(/\/java\/(.+)\/[^/]+$/); const pkg = m ? `package ${m[1].replace(/\//g, '.')};\n\n` : ''; return `${pkg}import org.junit.Test;\n\npublic class ${cls} {\n    @Test\n    public void standIn() {}\n}\n`; },
    source: (f) => { const p = require('path'); const cls = p.basename(f).replace(/\.(java|kt)$/, ''); const m = f.replace(/\\/g, '/').match(/\/java\/(.+)\/[^/]+$/); const pkg = m ? `package ${m[1].replace(/\//g, '.')};\n\n` : ''; return `${pkg}/** stand-in class written by the rehearsal */\npublic class ${cls} {}\n`; },
  },
  stack: 'java',
  installDir: null,
  protectedFiles: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'gradle.properties'],
  artifactDirs: ['build', '.gradle'],
  lockfiles: {},
  installCommand: () => './gradlew dependencies --quiet',
  addCommand: () => '',
  testCommand: () => './gradlew test',
  testFileCommand: (_run, files) => `./gradlew test --tests ${files
    .map((f) => f.split('/').pop().replace(/\.(java|kt)$/, '')).join(' --tests ')}`,
  deps: (text) => [...text.matchAll(/^\s*(?:implementation|api|testImplementation)\s+['"]([^'"]+)/gm)].map((m) => m[1]),
};
