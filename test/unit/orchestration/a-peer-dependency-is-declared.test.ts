/**
 * A PEER DEPENDENCY IS DECLARED.
 *
 * AMSD-2974 run 9, resume 4 (2026-10-11): cx-shared's writer was aborted by the dependency scan — "imported but NOT
 * DECLARED (present in a vendor dir only): react". cx-shared is a library; it declares react under peerDependencies,
 * the standard place a library declares what its host provides. The package.json provider's deps() reads only
 * dependencies and devDependencies (it answers "what does this manifest install", which the lockfile check relies on),
 * and the scan used it to answer a different question — "may code import this". The failure analyst diagnosed it
 * exactly ("react/react-dom only under peerDependencies, so the manifest checker flags any file importing react"),
 * and the writer died at max rung anyway.
 *
 * EXECUTED: the real scanImports (plugins/dependency-scan-plugin.js) on a fixture codeline with the project's scan
 * declaration, a file this change touched, and the package present in the vendor directory.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanImports } = require(join(__dirname, '../../../orchestrations/plugins/dependency-scan-plugin.js'));

const CONFIG = {
  manifestFile: 'package.json',
  scanFileExtensions: ['.ts', '.tsx'],
  importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
  vendorDirs: ['node_modules'],
};

function scan(manifest: object, imports: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'peer-dep-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'lib', ...manifest }));
  mkdirSync(join(d, '.epam')); writeFileSync(join(d, '.epam/dependency-check.json'), JSON.stringify(CONFIG));
  mkdirSync(join(d, 'src'));
  const lines = imports.map((p) => `import x from '${p}';`);
  writeFileSync(join(d, 'src/Toast.tsx'), `${lines.join('\n')}\n`);
  for (const p of imports) { mkdirSync(join(d, 'node_modules', p), { recursive: true }); writeFileSync(join(d, 'node_modules', p, 'package.json'), '{}'); }
  const r = scanImports(d, process.env, { changedFiles: ['src/Toast.tsx'], introducedLines: lines });
  return r;
}

const flagged = (r: any, pkg: string) => (r.findings || []).filter((f: any) => f.specifier === pkg && /undeclared/.test(f.verdict));

describe('what a library declares as a peer may be imported', () => {
  it('GUARD: the scan ran on the fixture — otherwise nothing below is a fact', () => {
    const r = scan({ dependencies: {} }, ['left-pad']);
    expect(r.status, JSON.stringify(r)).not.toBe('unknown');
    expect(flagged(r, 'left-pad').length, 'a truly undeclared import must still be caught').toBe(1);
  });

  it('a package declared under peerDependencies is not reported undeclared', () => {
    expect(flagged(scan({ peerDependencies: { react: '^18' } }, ['react']), 'react')).toEqual([]);
  });

  it('a package declared under optionalDependencies is not reported undeclared', () => {
    expect(flagged(scan({ optionalDependencies: { fsevents: '^2' } }, ['fsevents']), 'fsevents')).toEqual([]);
  });

  it('dependencies and devDependencies still declare, as before', () => {
    expect(flagged(scan({ dependencies: { a: '1' }, devDependencies: { b: '1' } }, ['a', 'b']), 'a')).toEqual([]);
  });
});
