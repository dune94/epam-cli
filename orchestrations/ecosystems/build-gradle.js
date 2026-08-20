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
