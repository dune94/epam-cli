/**
 * "IS THIS PACKAGE ACTUALLY AVAILABLE HERE?" — the fact nothing could answer.
 *
 * AMSD-2041, four consecutive runs. The detective's prescribed fix flipped between two
 * shapes with no input changing:
 *
 *   config  add live_preview:{...} to the ALREADY-INSTALLED Contentstack Stack options
 *   SDK     install @contentstack/live-preview-utils, init(), subscribe to onEntryChange
 *
 * The SDK route names a package declared in NO codeline. Nothing in the pipeline could
 * see that, because no artefact carries it: the writer-output manifest lists files,
 * package.json lists what IS declared, codeline-facts.json holds curated env gotchas, and
 * dependency-check.json describes HOW to check, not what a story needs. The requirement
 * existed only as prose inside fixSiteAnalysis[].fix — and only on 2 of 3 lanes.
 *
 * So the writer discovered it mid-turn, had no way to report a blockage, and invented a
 * URL-param workaround the reviewer called "dead code from a runtime perspective". Seven
 * self-heal diagnoses followed, all the same root, until HealingBroken fired.
 *
 * This tool makes the fact available BEFORE anyone commits to a plan. It distinguishes
 * four states that were previously one undifferentiated "not sure", including the one
 * `npm install --no-save` produces and which fooled everyone: present in node_modules,
 * absent from the manifest — builds green, ships broken.
 *
 * Vendor- and project-agnostic like its sibling tool: it names no package and no client,
 * and reads manifestFile/manifestKeys/vendorDirs from the project's own
 * dependency-check.json.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../../orchestrations/plugins/dependency-contract-tools.js');

const tool = () => {
  const t = plugin.tools.find((x: { name: string }) => x.name === 'dependency_available');
  if (!t) throw new Error('dependency_available tool is not exported by the plugin');
  return t;
};

/** A codeline with a manifest, a vendor dir, and its own dependency-check config. */
function codeline(opts: {
  declared?: Record<string, string>;
  installed?: string[];
  config?: Record<string, unknown>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'avail-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'client', dependencies: opts.declared ?? {} }, null, 2),
  );
  for (const pkg of opts.installed ?? []) {
    const dir = join(root, 'node_modules', ...pkg.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }));
  }
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(
    join(root, '.epam/dependency-check.json'),
    JSON.stringify(
      opts.config ?? {
        manifestFile: 'package.json',
        manifestKeys: ['dependencies', 'devDependencies'],
        vendorDirs: ['node_modules'],
      },
      null,
      2,
    ),
  );
  return root;
}

async function ask(root: string, packages: string[]) {
  const res = await tool().execute({ packages }, { cwd: root });
  expect(res.isError, `tool errored: ${res.content}`).toBeFalsy();
  return JSON.parse(res.content) as {
    projectRoot: string;
    results: Array<{ package: string; verdict: string; declared: boolean; installed: boolean }>;
  };
}

const verdictFor = (
  r: Awaited<ReturnType<typeof ask>>,
  pkg: string,
) => r.results.find((x) => x.package === pkg)?.verdict;

describe('dependency_available reports the four distinct states', () => {
  it('available — declared AND installed', async () => {
    const root = codeline({ declared: { 'some-sdk': '^1.0.0' }, installed: ['some-sdk'] });
    expect(verdictFor(await ask(root, ['some-sdk']), 'some-sdk')).toBe('available');
  });

  it('THE AMSD-2041 CASE: absent — a plan naming this cannot be implemented as written', async () => {
    const root = codeline({ declared: { 'other-pkg': '^1.0.0' }, installed: ['other-pkg'] });
    const r = await ask(root, ['missing-sdk']);
    expect(
      verdictFor(r, 'missing-sdk'),
      'this is the state of @contentstack/live-preview-utils on gotransit and upexpress — ' +
        'the prescribed fix named a package that is nowhere in the codeline, and nothing ' +
        'could report that until the writer discovered it mid-turn and faked a workaround',
    ).toBe('absent');
  });

  it('installed_undeclared — the --no-save state: builds green, ships broken', async () => {
    const root = codeline({ declared: {}, installed: ['ghost-sdk'] });
    const r = await ask(root, ['ghost-sdk']);
    expect(
      verdictFor(r, 'ghost-sdk'),
      'exactly what next.metrolinx.com looks like today: live-preview-utils sits in ' +
        'node_modules and is absent from package.json. tsc passes, tests pass, and a real ' +
        'user gets a runtime failure because nothing declares it. This must NOT read as ' +
        '"available".',
    ).toBe('installed_undeclared');
  });

  it('declared_not_installed — the manifest promises what the tree does not have', async () => {
    const root = codeline({ declared: { 'planned-sdk': '^2.0.0' }, installed: [] });
    expect(verdictFor(await ask(root, ['planned-sdk']), 'planned-sdk')).toBe('declared_not_installed');
  });
});

describe('it is driven by configuration, not by assumption', () => {
  it('honours a non-default manifestKeys — a devDependency counts as declared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avail-cfg-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'c', devDependencies: { 'tool-pkg': '^1.0.0' } }),
    );
    mkdirSync(join(root, 'node_modules/tool-pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules/tool-pkg/package.json'), '{"name":"tool-pkg"}');
    mkdirSync(join(root, '.epam'), { recursive: true });
    writeFileSync(
      join(root, '.epam/dependency-check.json'),
      JSON.stringify({
        manifestFile: 'package.json',
        manifestKeys: ['devDependencies'],
        vendorDirs: ['node_modules'],
      }),
    );
    expect(verdictFor(await ask(root, ['tool-pkg']), 'tool-pkg')).toBe('available');
  });

  it('names no package and no vendor in its own source', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src: string = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/plugins/dependency-contract-tools.js'),
      'utf8',
    );
    const body = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    expect(
      body,
      'this plugin must work unchanged on the next unknown dependency in the next unknown ' +
        'project — a client or vendor name in its logic is the hardcoding it exists to avoid',
    ).not.toMatch(/contentstack|metrolinx/i);
  });

  it('reports honestly when there is no config to read, rather than guessing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avail-nocfg-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'c', dependencies: {} }));
    const r = await ask(root, ['anything']);
    expect(r.results[0].verdict).toBe('absent');
  });
});

describe('it answers for several packages at once', () => {
  it('a mixed set comes back per-package, not collapsed', async () => {
    const root = codeline({ declared: { good: '^1.0.0' }, installed: ['good', 'ghost'] });
    const r = await ask(root, ['good', 'ghost', 'nowhere']);
    expect(verdictFor(r, 'good')).toBe('available');
    expect(verdictFor(r, 'ghost')).toBe('installed_undeclared');
    expect(verdictFor(r, 'nowhere')).toBe('absent');
  });
});
