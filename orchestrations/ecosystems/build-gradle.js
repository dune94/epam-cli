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
