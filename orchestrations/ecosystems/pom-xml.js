/**
 * ECOSYSTEM PROVIDER — Maven.
 *
 * Was an installer branch with no provider; see pipfile.js.
 */
module.exports = {
  precedence: 70,
  file: 'pom.xml',
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
  protectedFiles: ['pom.xml'],
  artifactDirs: ['target'],
  lockfiles: {},
  installCommand: () => 'mvn -q dependency:resolve',
  addCommand: () => 'mvn dependency:get -Dartifact={package}',
  testCommand: () => 'mvn -q test',
  // Maven selects tests by CLASS, not path: the file list is reduced to class names.
  testFileCommand: (_run, files) => `mvn -q test -Dtest=${files
    .map((f) => f.split('/').pop().replace(/\.(java|kt)$/, '')).join(',')}`,
  selfName: (text) => ((text.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1] || ''),
  deps: (text) => [...text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]),
};
