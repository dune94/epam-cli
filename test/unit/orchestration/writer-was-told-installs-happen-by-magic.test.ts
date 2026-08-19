// THE WRITER WAS TOLD, IN PROSE HARDCODED IN SHELL, THAT INSTALLS HAPPEN BY THEMSELVES.
//
// claude.sh carried this directive as a shell string literal:
//
//   "If the fix genuinely requires a package this project does not yet declare, import it directly
//    and continue ... Missing imports are detected and installed automatically after your change;
//    this does not need your permission or a separate step."
//
// On live metrolinx AMSD-2041 the writer did exactly that: it added the package to package.json by
// hand and imported it. Nothing installed anything — autoInstall fires only when the PROJECT
// declares it, and this one does not — so package-lock.json never moved and the branch cannot be
// installed from a clean checkout. The instruction was a promise the pipeline does not keep.
//
// Two defects in one string: the prose lived in code rather than in the template layer, and it was
// false. Both are fixed here, and the directive now names the project's OWN install command,
// resolved from lib/ecosystems.js rather than assumed to be npm.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/new-dependency-directive.json');
const NOTE_TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/new-dependency-lockfile-note.json');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

/** Render one REAL template through the REAL engine renderer. */
function renderOne(id: string, values: Record<string, string>): string {
  const vals = join(mkdtempSync(join(tmpdir(), 'dep-directive-')), 'values.json');
  writeFileSync(vals, JSON.stringify(values));
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/render-engine-prompt.sh'))}; ` +
    `render_engine_prompt ${id} ${JSON.stringify(vals)}`,
  ], { encoding: 'utf8', env: { ...process.env, NODE_CMD: NODE } });
  if (r.status !== 0) throw new Error(`render failed (${r.status}): ${r.stderr}`);
  return r.stdout || '';
}

/**
 * The directive as the writer receives it: the parent block, with the lockfile block rendered
 * into it -- the same two-step claude.sh performs. The lockfile half is separate so that a
 * codeline carrying NO lockfile still gets the half that stops the agent stalling.
 */
function render(v: { __INSTALL_COMMAND__: string; __MANIFEST_FILE__?: string; __LOCKFILE__?: string }): string {
  const note = v.__MANIFEST_FILE__ && v.__LOCKFILE__
    ? renderOne('new-dependency-lockfile-note',
        { __MANIFEST_FILE__: v.__MANIFEST_FILE__, __LOCKFILE__: v.__LOCKFILE__ })
    : '';
  return renderOne('new-dependency-directive',
    { __INSTALL_COMMAND__: v.__INSTALL_COMMAND__, __LOCKFILE_NOTE__: note });
}

describe('the prose left the code', () => {
  it('claude.sh no longer carries the directive as a shell string', () => {
    expect(CLAUDE_SH).not.toContain('installed automatically after your change');
    expect(CLAUDE_SH).not.toContain('## Adding a New Dependency');
  });

  it('the template layer carries it instead', () => {
    expect(existsSync(TEMPLATE), 'the directive has no prompt file').toBe(true);
  });
});

describe('what the directive now says', () => {
  const out = () => render({
    __INSTALL_COMMAND__: 'pnpm add <package>',
    __MANIFEST_FILE__: 'package.json',
    __LOCKFILE__: 'pnpm-lock.yaml',
  });

  it('renders to something', () => {
    expect(out().trim().length, 'an empty render makes every assertion below vacuous')
      .toBeGreaterThan(80);
  });

  it("names the project's own install command, not npm", () => {
    const t = out();
    expect(t).toContain('pnpm add <package>');
    expect(t).not.toMatch(/\bnpm install\b/);
  });

  it('names the lockfile that must move with the manifest', () => {
    expect(out()).toContain('pnpm-lock.yaml');
  });

  it('no longer promises that the install happens on its own', () => {
    const t = out().toLowerCase();
    expect(t).not.toContain('automatically');
    expect(t).not.toContain('does not need your permission');
  });

  it('still tells the writer to proceed rather than stop and ask', () => {
    // The original directive existed because agents stalled asking permission. That problem is
    // real and the fix must not reintroduce it.
    expect(out().toLowerCase()).toMatch(/do not stop|continue|proceed/);
  });

  it('carries no ecosystem name of its own — in either block', () => {
    for (const f of [TEMPLATE, NOTE_TEMPLATE]) {
      const body = JSON.parse(readFileSync(f, 'utf8')).body as string;
      for (const word of ['npm', 'pnpm', 'yarn', 'pip', 'cargo', 'bundle', 'package.json']) {
        expect(body.toLowerCase(), `${f} hardcodes "${word}"`).not.toContain(word);
      }
    }
  });

  it('still delivers the anti-stall half to a codeline with NO lockfile', () => {
    // The first version of this refused to render without a lockfile, which silently withdrew the
    // instruction that stops an agent stalling — the reason the directive exists at all.
    const t = render({ __INSTALL_COMMAND__: 'go get <package>' });
    expect(t).toContain('go get <package>');
    expect(t.toLowerCase()).toMatch(/do not stop|continue|proceed/);
  });
});

// The command must be the one that ADDS a package. installCommand provisions what the manifest
// already declares and cannot add anything — telling an agent to run it to add a dependency is
// precisely how AMSD-2041 produced a manifest entry no lockfile resolved.
describe('the command the directive names', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MANIFESTS } = require(join(ROOT, 'orchestrations/scripts/lib/ecosystems.js'));
  const eco = (f: string) => MANIFESTS.find((e: { file: string }) => e.file === f);

  it('adds a package rather than provisioning the manifest', () => {
    expect(eco('package.json').addCommand('npm')).toContain('{package}');
    expect(eco('package.json').installCommand('npm')).not.toContain('{package}');
  });

  it('follows the package manager the lockfile names, not npm', () => {
    expect(eco('package.json').addCommand('yarn')).toBe('yarn add {package}');
    expect(eco('package.json').addCommand('pnpm')).toBe('pnpm add {package}');
  });

  it('answers for every ecosystem that has a lockfile to keep in step', () => {
    for (const e of MANIFESTS) {
      if (!Object.keys(e.lockfiles || {}).length) continue;
      const cmd = e.addCommand?.(Object.values(e.lockfiles)[0]);
      expect(cmd, `${e.file} cannot say how to add a dependency`).toContain('{package}');
    }
  });
});
