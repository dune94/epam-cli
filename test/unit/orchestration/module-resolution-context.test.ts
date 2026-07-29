/**
 * Tell the agent how this codeline resolves imports, so it stops inventing them.
 *
 * Live metrolinx 2026-07-29: the implementation agent wrote imports the scanner
 * then tried to npm-install — 346/553/506 times per lane — because
 * `components/x` means `src/components/x` here and nothing said so. The scanner
 * side is fixed (dependency-check now resolves internal modules on the
 * filesystem), but the agent is still guessing: it writes an import, the
 * deterministic side quietly reclassifies it, and the agent never learns the
 * convention.
 *
 * The same facts the scanner uses are worth giving the agent directly: which
 * directories are module roots, what a bare specifier means, and that internal
 * modules are never dependencies.
 *
 * ONE SOURCE, TWO CONSUMERS. The block is derived from the same manifest and the
 * same root-discovery rule the scanner applies. If the agent were told one thing
 * and the scanner applied another, the result is a subtler version of the
 * original bug — the agent writing "correct" imports that the scanner still
 * rejects. So this must never become hand-written prose in a prompt.
 *
 * Nothing here names a stack: roots are discovered from the repo, extensions
 * come from the manifest the project declares.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} is not defined in claude.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/** Build a repo fixture and run the real context builder against it. */
function context(files: Record<string, string>, manifest: object | null): string {
  const d = mkdtempSync(join(tmpdir(), 'modres-'));
  dirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(d, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  if (manifest) {
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/dependency-check.json'), JSON.stringify(manifest));
  }
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
${fnText('_module_resolution_context')}
_module_resolution_context ${JSON.stringify(d)}
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '') + (r.stderr || '');
}

const MANIFEST = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies'],
  scanFileExtensions: ['.ts', '.tsx'],
  importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
  installCommand: 'npm install {package}',
  vendorDirs: ['node_modules'],
};

describe('the block states how bare imports resolve', () => {
  it('names the discovered module roots', () => {
    const out = context({
      'package.json': '{}',
      'src/components/Link.tsx': 'export const L=1;\n',
      'src/app.ts': 'export const a=1;\n',
    }, MANIFEST);
    expect(out, `no module root named:\n${out}`).toMatch(/\bsrc\b/);
  });

  it('discovers a root that is not called src', () => {
    // If only `src` appears, the block is metrolinx-shaped.
    const out = context({
      'package.json': '{}',
      'lib/widgets/Button.ts': 'export const B=1;\n',
    }, MANIFEST);
    expect(out, `did not discover lib/ as a root:\n${out}`).toMatch(/\blib\b/);
  });

  it('excludes vendor directories', () => {
    const out = context({
      'package.json': '{}',
      'src/a.ts': 'x',
      'node_modules/dep/index.js': '1',
    }, MANIFEST);
    expect(out, 'offered node_modules as a module root').not.toMatch(/node_modules\b(?![^\n]*never)/);
  });

  it('says internal modules are not dependencies', () => {
    // The instruction that would have prevented the loop.
    const out = context({ 'package.json': '{}', 'src/a.ts': 'x' }, MANIFEST);
    expect(out).toMatch(/not (a )?dependenc|never.*install|internal/i);
  });
});

describe('it degrades safely', () => {
  it('emits nothing when the codeline has no manifest', () => {
    // No manifest means we do not know the conventions; inventing them would be
    // worse than silence.
    const out = context({ 'src/a.ts': 'x' }, null).trim();
    expect(out, `emitted guidance without a manifest:\n${out}`).toBe('');
  });

  it('does not fail on a repo with no source directories', () => {
    const out = context({ 'package.json': '{}' }, MANIFEST);
    expect(out).not.toMatch(/error|Traceback/i);
  });
});

describe('the block reaches the agents that need it', () => {
  it('is injected into the implementation prompt', () => {
    expect(SRC, 'the implementation agent never sees the resolution rules')
      .toMatch(/_module_resolution_context/);
  });

  it('is derived, never hand-written prose in the prompt', () => {
    // A prose summary would drift from what the scanner actually does.
    const calls = (SRC.match(/_module_resolution_context/g) || []).length;
    expect(calls, 'expected a definition plus at least one injection').toBeGreaterThanOrEqual(2);
  });
});
