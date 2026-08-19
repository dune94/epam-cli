// THE ENGINE PINNED NODE 20 AND THE CODELINE REQUIRED 22.
//
// detect_node() listed four literal paths — v20.20.2 and v20.20.0 under fnm and nvm — and checked
// them BEFORE whatever `node` is on PATH. next.metrolinx.com declares its requirement in three
// places: .nvmrc says v22, package.json engines says "22.x", and .epam/codeline-facts.json (which
// the pipeline generated itself) records "Node 22.x is required; other versions may not work."
//
// So the engine ran a 245-file jest suite under a runtime the codeline says will not work, and any
// resulting failure reads as a defect in the story's code. There was no env var to correct it:
// NODE_BIN is a different variable used at other call sites, so the codeline's declaration was
// unreachable through configuration.
//
// The fix must not swap one pinned version for another. The requirement comes from the codeline;
// the runtime is DISCOVERED from whatever is installed; a version literal in engine code would
// just move the defect.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const made: string[] = [];

function repo(opts: { nvmrc?: string; engines?: string }): string {
  const d = mkdtempSync(join(tmpdir(), 'noderepo-')); made.push(d);
  const pkg: Record<string, unknown> = { name: 'fixture' };
  if (opts.engines) pkg.engines = { node: opts.engines };
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg, null, 2));
  if (opts.nvmrc) writeFileSync(join(d, '.nvmrc'), opts.nvmrc + '\n');
  return d;
}

/** A fake nvm-layout install root containing the given versions. */
function installs(versions: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'nodeinstalls-')); made.push(d);
  for (const v of versions) {
    const bin = join(d, v, 'bin');
    mkdirSync(bin, { recursive: true });
    const f = join(bin, 'node');
    writeFileSync(f, `#!/bin/sh\necho "${v}"\n`); chmodSync(f, 0o755);
  }
  return d;
}

function sh(body: string, env: Record<string, string> = {}): string {
  const assigns = Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n');
  const script = `
set +e
log() { :; }; warning() { :; }; error() { :; }; info() { :; }; success() { :; }
${assigns}
eval "$(awk '/^_codeline_node_requirement\\(\\) \\{/,/^\\}/' "${ORCH}")"
eval "$(awk '/^detect_node\\(\\) \\{/,/^\\}/' "${ORCH}")"
${body}
`;
  return (spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout || '').trim();
}

afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe('the node requirement comes from the codeline', () => {
  it('reads .nvmrc', () => {
    const r = repo({ nvmrc: 'v22' });
    expect(sh(`declare -F _codeline_node_requirement >/dev/null || { echo NOFUNC; exit 0; }
_codeline_node_requirement "${r}"`)).toBe('22');
  });

  it('falls back to package.json engines when there is no .nvmrc', () => {
    const r = repo({ engines: '22.x' });
    expect(sh(`declare -F _codeline_node_requirement >/dev/null || { echo NOFUNC; exit 0; }
_codeline_node_requirement "${r}"`)).toBe('22');
  });

  it('says nothing when the codeline declares nothing — absence is not a version', () => {
    const r = repo({});
    expect(sh(`declare -F _codeline_node_requirement >/dev/null || { echo NOFUNC; exit 0; }
_codeline_node_requirement "${r}"`)).toBe('');
  });
});

describe('the runtime is discovered, not listed', () => {
  it('THE DEFECT: picks the major the codeline asked for, from what is installed', () => {
    const r = repo({ nvmrc: 'v22' });
    const root = installs(['v18.19.0', 'v20.20.0', 'v22.11.0']);
    const bin = sh(`declare -F detect_node >/dev/null || { echo NOFUNC; exit 0; }
detect_node "${r}"`, { EPAM_NODE_INSTALL_ROOTS: root });
    expect(bin, 'a hardcoded v20 list cannot satisfy a codeline asking for 22').toMatch(/v22\./);
  });

  it('picks a DIFFERENT major when the codeline asks for one — proving nothing is pinned', () => {
    const r = repo({ nvmrc: 'v18' });
    const root = installs(['v18.19.0', 'v20.20.0', 'v22.11.0']);
    expect(sh(`detect_node "${r}"`, { EPAM_NODE_INSTALL_ROOTS: root })).toMatch(/v18\./);
  });

  it('prefers the HIGHEST patch within the requested major', () => {
    const r = repo({ nvmrc: 'v22' });
    const root = installs(['v22.2.0', 'v22.11.0']);
    expect(sh(`detect_node "${r}"`, { EPAM_NODE_INSTALL_ROOTS: root })).toMatch(/v22\.11\.0/);
  });

  it('a codeline that declares nothing inherits the ENGINE\'s declaration, read not pinned', () => {
    const r = repo({});                       // declares neither .nvmrc nor engines (mock3 shape)
    const engine = repo({ nvmrc: 'v18' });    // stands in for the engine repo
    const root = installs(['v18.19.0', 'v20.20.0', 'v24.14.1']);
    const out = sh(`detect_node "${r}"`, { EPAM_NODE_INSTALL_ROOTS: root, EPAM_ENGINE_ROOT: engine });
    // If this were pinned, or defaulted to "highest installed", it would return v24.
    expect(out, 'the engine default is not being read from the engine\'s own declaration')
      .toMatch(/v18\./);
  });

  it('carries no version literal — an unsatisfiable requirement yields nothing, not a guess', () => {
    const r = repo({ nvmrc: 'v99' });
    const root = installs(['v20.20.0']);
    const out = sh(`detect_node "${r}"`, { EPAM_NODE_INSTALL_ROOTS: root });
    expect(out, 'returned a runtime the codeline did not ask for').toBe('');
  });
});
