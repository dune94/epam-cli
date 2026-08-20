/**
 * ECOSYSTEM PROVIDER — Maven.
 *
 * Was an installer branch with no provider; see pipfile.js.
 */
module.exports = {
  precedence: 70,
  file: 'pom.xml',
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
