// THE WRITER COULD NOT FIX WHAT WAS NEVER IN SCOPE.
//
// Live metrolinx AMSD-2041, three runs. The feature is Contentstack Live Preview, which works by
// the CMS embedding the site in an iframe and the page re-fetching draft content. This codeline's
// next.config.js sets `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, and its
// connect-src names no Contentstack host — so the feature cannot function however well the source
// is written.
//
// No agent ever had a chance at it. `next.config.js` appears ZERO times anywhere in the story: not
// in technicalNotes.files, not in the description, not in the detective's prescription. The fix
// sites named only the source files that implement the behaviour, never the configuration that
// governs whether the behaviour is permitted to happen.
//
// The engine must not name that file: which configuration governs a codeline is a fact about the
// codeline's stack. client-env-boundary-plugin.js already resolves an adapter from the repository's
// OWN manifest (`detect: (deps) => Boolean(deps.next)`) and already declares that stack's config
// files. The detective is handed what the adapter declares, and decides whether the change's
// behaviour depends on it.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const ROOT = join(__dirname, '../../..');
const PLUGIN = join(ROOT, 'orchestrations/plugins/client-env-boundary-plugin.js');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/code-graph-detective.json');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = () => require(PLUGIN);

/** A repository of a given stack, carrying the config file that stack uses. */
function repoFor(dep: string, configFile: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'cfg-surface-')); made.push(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'f', dependencies: { [dep]: '1.0.0' } }));
  if (configFile) writeFileSync(join(d, configFile), '// config\n');
  mkdirSync(join(d, 'src'), { recursive: true });
  return d;
}

describe('the configuration surface comes from the codeline', () => {
  it('is exposed by the plugin that already resolves the stack', () => {
    expect(typeof plugin().configSurface,
      'nothing can ask which configuration governs this codeline').toBe('function');
  });

  it('finds the config a Next.js repository actually carries', () => {
    const repo = repoFor('next', 'next.config.js');
    expect(plugin().configSurface(repo)).toContain('next.config.js');
  });

  it('finds a different stack\'s config without the engine knowing either name', () => {
    const repo = repoFor('vite', 'vite.config.ts');
    expect(plugin().configSurface(repo)).toContain('vite.config.ts');
  });

  it('reports nothing for a stack it does not recognise — absent is absent', () => {
    const repo = repoFor('some-unknown-framework', 'whatever.config.js');
    expect(plugin().configSurface(repo)).toEqual([]);
  });

  it('reports nothing when the declared config file is not present', () => {
    const repo = repoFor('next', null);
    expect(plugin().configSurface(repo)).toEqual([]);
  });
});

describe('the detective is asked about it', () => {
  const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const body = (): string => {
    const j = template();
    return String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
  };

  it('declares the placeholder', () => {
    expect(template().placeholders).toContain('__CONFIG_SURFACE__');
  });

  it('instructs it to consider configuration that governs the behaviour', () => {
    expect(body().toLowerCase()).toMatch(/configuration|config file/);
  });

  it('names no configuration file of its own', () => {
    for (const f of ['next.config', 'vite.config', 'webpack.config', 'tsconfig.json']) {
      expect(body(), `the template hardcodes ${f}`).not.toContain(f);
    }
  });

  it('the producer supplies it', () => {
    // The detective prompt is rendered by spec-mode-runner.js, not claude.sh — the first version
    // of this test asserted the wrong file and failed against correct code.
    const js = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    expect(js).toMatch(/__CONFIG_SURFACE__/);
  });

  it('and resolves it through the codeline, naming no framework itself', () => {
    const js = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const block = js.slice(js.indexOf('function configSurfaceBlock'), js.indexOf('function surveyHypothesisBlock'));
    expect(block).toMatch(/configSurface\(/);
    for (const f of ['next.config', 'vite.config']) expect(block).not.toContain(f);
  });
});
