/**
 * WHAT A FILE OF THIS STACK HOLDS — asked of the engine's own ecosystem declarations.
 *
 * Every ecosystem the engine supports declares its stand-in content (a manifest naming the test
 * runner, a test that passes, a source module that imports, files its tools parse) and how its test
 * and source files are recognised. The mock knows no stack: it asks the install's registry which
 * ecosystem this codeline (or, before it exists, the stories) resolves to, and takes that
 * ecosystem's declared content for each path. The question runs in a child process against the
 * install under test, so the answer is always the current declaration.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export type Delivery = { path: string; content: string; kind: 'manifest' | 'named' | 'test' | 'source' | 'other' };

const ASK = `
const path = require('path');
const [scripts, root, prdFile, filesJson] = process.argv.slice(1);
const files = JSON.parse(filesJson);
let eco = null;
try { const hit = require(path.join(scripts, 'lib/handlers/codeline-manifests.js')).resolveEcosystem(root); if (hit) eco = hit.eco; } catch {}
if (!eco) { try { eco = require(path.join(scripts, 'lib/ecosystem-registry.js')).declaredByStories(JSON.parse(require('fs').readFileSync(prdFile, 'utf8')).stories); } catch {} }
if (!eco || !eco.standIn) { process.stdout.write('null'); process.exit(0); }
const cg = (eco.codelineManifests && eco.codelineManifests.contractGeneration) || {};
const testRe = cg.testFilePattern ? new RegExp(cg.testFilePattern) : null;
const srcExt = cg.sourceExtensions || [];
const byName = eco.standIn.byName || {};
const val = (v, f) => (typeof v === 'function' ? v(f) : v);
const out = files.map((f0) => {
  const f = /\\/$/.test(f0) ? path.posix.join(f0, 'stand_in' + (srcExt[0] || '.txt')) : f0;
  const base = path.basename(f);
  if (base === eco.file) return { path: f, content: val(eco.standIn.manifest, f), kind: 'manifest' };
  if (Object.prototype.hasOwnProperty.call(byName, base)) return { path: f, content: val(byName[base], f), kind: 'named' };
  if (testRe && testRe.test(f)) return { path: f, content: val(eco.standIn.test, f), kind: 'test' };
  if (srcExt.some((x) => f.endsWith(x))) return { path: f, content: val(eco.standIn.source, f), kind: 'source' };
  return { path: f, content: '', kind: 'other' };
});
process.stdout.write(JSON.stringify(out));
`;

/** The declared content for each file a story delivers, or null when no ecosystem declares any. */
export function deliveries(install: string, codelineRoot: string, prdFile: string, files: string[]): Delivery[] | null {
  const raw = execFileSync(process.execPath, ['-e', ASK, join(install, 'orchestrations/scripts'), codelineRoot, prdFile, JSON.stringify(files)], { encoding: 'utf8' });
  const out = JSON.parse(raw) as Delivery[] | null;
  // A file no ecosystem content fits (docs, config) is still delivered, never empty: the
  // deliverable check reads an empty file as missing.
  return out && out.map((d) => ({ ...d, content: d.content || `${d.path}: delivered for this story\n` }));
}
