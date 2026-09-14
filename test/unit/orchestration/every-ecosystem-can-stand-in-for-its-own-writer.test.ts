/**
 * EVERY ECOSYSTEM CAN STAND IN FOR ITS OWN WRITER.
 *
 * The £0 rehearsal's writer lands a story's declared deliverables with content the codeline's
 * ecosystem declares — a manifest that names the test runner, a test that passes, a source file
 * that compiles. Only the Python provider declared any, so a Node greenfield project (the other
 * install's, and skyscanner here) got a writer that could land nothing and every attempt failed
 * (2026-09-14). The pipeline is generic: a provider that cannot stand in for its writer leaves its
 * whole stack unrehearsable, so every provider is judged, by executing its declarations.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const { loadProviders } = require(path.join(ROOT, 'orchestrations/scripts/lib/ecosystem-registry.js'));
const providers: any[] = loadProviders();

describe('every ecosystem can stand in for its own writer', () => {
  it('there are providers', () => { expect(providers.length).toBeGreaterThan(1); });
  for (const eco of providers) {
    describe(eco.file, () => {
      const cg = eco.codelineManifests && eco.codelineManifests.contractGeneration;
      it('declares how its tests are told from its sources', () => {
        expect(cg && cg.testFilePattern, 'no contractGeneration.testFilePattern').toBeTruthy();
        expect(() => new RegExp(cg.testFilePattern)).not.toThrow();
        expect(Array.isArray(cg.sourceExtensions) && cg.sourceExtensions.length, 'no sourceExtensions').toBeTruthy();
      });
      it('declares a stand-in manifest, test and source', () => {
        expect(eco.standIn, 'no standIn').toBeTruthy();
        for (const k of ['manifest', 'test', 'source']) expect(['string', 'function']).toContain(typeof eco.standIn[k]);
      });
      it('the stand-in manifest names a test command its own rule resolves', () => {
        const manifest = typeof eco.standIn.manifest === 'function' ? eco.standIn.manifest(eco.file) : eco.standIn.manifest;
        expect(manifest.trim().length).toBeGreaterThan(0);
        const cmd = eco.testCommand(manifest, Object.values(eco.lockfiles || {})[0]);
        expect(cmd, `${eco.file}: its own testCommand reads no test command from its own stand-in manifest`).toBeTruthy();
      });
      it('the stand-in test lands in a path its own pattern reads as a test, and is not empty', () => {
        // A test path shaped the way this ecosystem's pattern requires: built from the pattern's
        // own literal parts is not possible generically, so the provider is asked to recognise a
        // conventional path for its language; the assertion is that SOME path it recognises exists
        // and its stand-in for that path is non-empty and differs from the source stand-in.
        const re = new RegExp(cg.testFilePattern);
        const candidates = ['tests/test_x.py', 'src/x.test.ts', 'tests/x_test.rs', 'x_test.go', 'test/x_test.rb', 'src/test/java/a/XTest.java', 'tests/XTest.php', 'spec/x_spec.rb'];
        const hit = candidates.find((c) => re.test(c));
        expect(hit, `no conventional test path matches ${cg.testFilePattern}`).toBeTruthy();
        const t = typeof eco.standIn.test === 'function' ? eco.standIn.test(`/repo/${hit}`) : eco.standIn.test;
        const s = typeof eco.standIn.source === 'function' ? eco.standIn.source(`/repo/src/x${cg.sourceExtensions[0]}`) : eco.standIn.source;
        expect(t.trim().length).toBeGreaterThan(0);
        expect(s.trim().length).toBeGreaterThan(0);
        expect(t).not.toBe(s);
      });
    });
  }
});
