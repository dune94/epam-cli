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
    // HOW THIS ECOSYSTEM'S TESTS ARE TOLD FROM ITS SOURCES — read by the change classifier, the
    // test gates and the rehearsal's stand-in writer (which must write a test into a test file
    // and a module into a module).
    contractGeneration: {
      language: 'java',
      sourceExtensions: ['.java', '.kt'],
      excludePattern: '(^|/)src/test/.*\\.(java|kt)$',
      testFilePattern: '(^|/)src/test/.*\\.(java|kt)$',
      // One path this ecosystem itself reads as a test — declared beside the pattern so a test of the
      // pattern needs no list of conventions.
      exampleTestPath: 'src/test/java/a/XTest.java',
    },
  },
  // WHAT A STAND-IN DELIVERABLE HOLDS, so a £0 rehearsal's writer can land files the gates will
  // run: a manifest that names the test runner, a test that passes, a source file that compiles.
  // A function receives the deliverable's path where the content must agree with it.
  standIn: {
    manifest: '<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>standin</groupId>\n  <artifactId>stand-in</artifactId>\n  <version>0.0.0</version>\n  <dependencies>\n    <dependency>\n      <groupId>junit</groupId>\n      <artifactId>junit</artifactId>\n      <version>4.13.2</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n</project>\n',
    test: (f) => { const p = require('path'); const cls = p.basename(f).replace(/\.(java|kt)$/, ''); const m = f.replace(/\\/g, '/').match(/\/java\/(.+)\/[^/]+$/); const pkg = m ? `package ${m[1].replace(/\//g, '.')};\n\n` : ''; return `${pkg}import org.junit.Test;\n\npublic class ${cls} {\n    @Test\n    public void standIn() {}\n}\n`; },
    source: (f) => { const p = require('path'); const cls = p.basename(f).replace(/\.(java|kt)$/, ''); const m = f.replace(/\\/g, '/').match(/\/java\/(.+)\/[^/]+$/); const pkg = m ? `package ${m[1].replace(/\//g, '.')};\n\n` : ''; return `${pkg}/** stand-in class written by the rehearsal */\npublic class ${cls} {}\n`; },
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
