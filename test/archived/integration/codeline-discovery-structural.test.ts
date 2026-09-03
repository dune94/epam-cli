/**
 * INTEGRATION — codeline discovery must rank on STRUCTURE, not on word frequency.
 *
 * THE ARCHITECTURAL DEFECT THIS LOCKS OUT
 * ---------------------------------------
 * scoreRepos() ranked repositories by lexical text-match frequency: it asked
 * CodeGraph "how often do the ticket's words appear in this repo's text". But
 * the question discovery must answer is "which repo IMPLEMENTS the capability
 * this ticket concerns". Those are different questions, and term frequency
 * cannot tell them apart.
 *
 * Live evidence (AMSD-2041, five runs): `c365` scored 143 against
 * next.gotransit.com's 152 — a 1.06 ratio, effectively a tie — on 25
 * "contentstack" hits that were all CRM accessibility validators. It contains
 * zero live-preview code and has no installed toolchain, so it could not run
 * its own gates even if selected. The model refused it four times and included
 * it on the fifth with a confident, wrong justification. The response at the
 * time was to PIN the codeline list in config, which disabled agentic discovery
 * entirely rather than fixing the scorer.
 *
 * Every mechanism layered on top — a hand-maintained transit stopword list, a
 * recency multiplier, cross-repo IDF, near-tie confidence reporting — is a
 * correction applied to a signal that measures the wrong thing.
 *
 * THE PROPERTY UNDER TEST
 * -----------------------
 * A repository that merely MENTIONS a technology heavily, but neither declares
 * a dependency on it nor can build, must lose to a repository that declares the
 * dependency and can build — even when the mentioner wins on raw term count.
 *
 * These tests build REAL git repositories on disk with real manifests and run
 * the REAL scoring module against them. Nothing is stubbed above the filesystem.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const structure = require(join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-structure.js'));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function gitRepo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `cl-struct-${name}-`));
  dirs.push(root);
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 't']);
  return root;
}

/** The real implementer: declares the dependency AND has it installed. */
function implementerRepo(dep: string): string {
  const r = gitRepo('impl');
  writeFileSync(join(r, 'package.json'), JSON.stringify({
    name: 'the-site', dependencies: { [dep]: '^1.0.0' },
  }));
  mkdirSync(join(r, 'node_modules', dep), { recursive: true });
  writeFileSync(join(r, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep }));
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'src', 'provider.ts'), `import x from '${dep}';\nexport const use = x;\n`);
  return r;
}

/**
 * The c365 shape: mentions the term far MORE often than the implementer, but
 * declares no dependency on it and has no installed toolchain.
 */
function mentionerRepo(dep: string): string {
  const r = gitRepo('mention');
  writeFileSync(join(r, 'package.json'), JSON.stringify({
    name: 'crm-integration', dependencies: { 'unrelated-crm-sdk': '^2.0.0' },
  }));
  mkdirSync(join(r, 'validators'), { recursive: true });
  // Heavy lexical presence — deliberately more mentions than the implementer.
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(r, 'validators', `v${i}.cs`), `// ${dep} accessibility request validator\n`);
  }
  return r;
}

const DEP = 'live-preview-utils';

describe('declaredDependencies — reads the repo\'s own manifest, stack-agnostic', () => {
  it('finds a declared npm dependency', () => {
    const deps = structure.declaredDependencies(implementerRepo(DEP));
    expect([...deps]).toContain(DEP);
  });

  it('does NOT invent a dependency a repo never declared', () => {
    const deps = structure.declaredDependencies(mentionerRepo(DEP));
    expect(
      [...deps],
      'the mentioner names the term 25 times in source but declares no dependency on it',
    ).not.toContain(DEP);
  });

  it('reads a non-npm manifest too — no stack is privileged', () => {
    const r = gitRepo('py');
    writeFileSync(join(r, 'pyproject.toml'), '[project]\ndependencies = ["requests", "flask"]\n');
    const deps = structure.declaredDependencies(r);
    expect([...deps]).toEqual(expect.arrayContaining(['requests', 'flask']));
  });

  it('a repo with no manifest at all yields no dependencies and does not throw', () => {
    expect([...structure.declaredDependencies(gitRepo('bare'))]).toEqual([]);
  });
});

describe('canRunItsOwnGates — a repo that cannot build is not a candidate at any score', () => {
  it('true when declared dependencies are installed', () => {
    expect(structure.canRunItsOwnGates(implementerRepo(DEP))).toBe(true);
  });

  it('FALSE when a manifest declares dependencies but none are installed (the c365 shape)', () => {
    expect(
      structure.canRunItsOwnGates(mentionerRepo(DEP)),
      'c365 had no installed toolchain — as a lane it could not run its own gates, ' +
        'so selecting it guarantees a failed run regardless of relevance',
    ).toBe(false);
  });

  it('true when the repo declares no dependencies — nothing to install is not unhealthy', () => {
    expect(structure.canRunItsOwnGates(gitRepo('bare'))).toBe(true);
  });
});

describe('THE REGRESSION: structure beats word count', () => {
  it('the implementer outranks the heavy mentioner, despite fewer mentions', () => {
    const impl = implementerRepo(DEP);
    const mention = mentionerRepo(DEP);
    const terms = [DEP, 'preview', 'draft'];

    // Lexical reality, stated plainly: the mentioner genuinely wins on raw count.
    const lexImpl = structure.lexicalMentionCount(impl, DEP);
    const lexMention = structure.lexicalMentionCount(mention, DEP);
    expect(lexMention, 'fixture is wrong — the mentioner must win on raw term count').toBeGreaterThan(lexImpl);

    const scored = structure.rankByStructure(
      [{ name: 'crm-integration', path: mention }, { name: 'the-site', path: impl }],
      terms,
    );

    expect(scored[0].name, `ranking put the mentioner first: ${JSON.stringify(scored)}`).toBe('the-site');
  });

  it('a repo that cannot build is excluded outright, not merely demoted', () => {
    const scored = structure.rankByStructure(
      [{ name: 'crm-integration', path: mentionerRepo(DEP) }, { name: 'the-site', path: implementerRepo(DEP) }],
      [DEP],
    );
    expect(scored.map((r: any) => r.name)).not.toContain('crm-integration');
  });

  it('two buildable implementers are BOTH kept — this filters the unusable, it does not pick one', () => {
    const a = implementerRepo(DEP);
    const b = implementerRepo(DEP);
    const scored = structure.rankByStructure(
      [{ name: 'site-a', path: a }, { name: 'site-b', path: b }],
      [DEP],
    );
    expect(
      scored.map((r: any) => r.name).sort(),
      'a multi-codeline ticket must not be narrowed to one repo by the scorer',
    ).toEqual(['site-a', 'site-b']);
  });
});

describe('WIRED INTO THE REAL SCORER — not just available as a module', () => {
  // The module can be perfect and change nothing if scoreRepos never calls it.
  // This runs the REAL discovery CLI in dry-run over real repos on disk.
  function runDiscovery(repos: { name: string; path: string }[]) {
    const root = mkdtempSync(join(tmpdir(), 'cl-root-'));
    dirs.push(root);
    for (const r of repos) {
      spawnSync('cp', ['-r', r.path, join(root, r.name)]);
    }
    const issues = join(root, 'issues.json');
    writeFileSync(issues, JSON.stringify([{
      key: 'T-1',
      title: `${DEP} preview support`,
      description: `Add ${DEP} draft preview to the site.`,
    }]));
    const out = join(root, 'out.json');
    const r = spawnSync('node', [
      join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'),
      '--issues', issues, '--root', root, '--out', out, '--dry-run',
    ], { encoding: 'utf8', timeout: 120000, env: { ...process.env, CODEGRAPH_ENABLED: '0' } });
    return (r.stdout || '') + (r.stderr || '');
  }

  it('the real CLI EXCLUDES the unbuildable mentioner and picks the implementer', () => {
    const log = runDiscovery([
      { name: 'crm-integration', path: mentionerRepo(DEP) },
      { name: 'the-site', path: implementerRepo(DEP) },
    ]);
    expect(log, `discovery log:\n${log}`).toMatch(/EXCLUDED 'crm-integration'/);
    expect(log).toMatch(/codeline 'thesite'|codeline 'the-site'|the-site/);
  });
});

describe('no client or domain vocabulary is hardcoded in the scorer', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src = require('node:fs').readFileSync(
    join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'), 'utf8');

  it('the transit stopword list is gone — cross-repo IDF already demotes ubiquitous terms', () => {
    expect(
      src,
      'DOMAIN_STOPWORDS hardcoded a client industry vocabulary (trip/fare/station/passenger) ' +
        'into engine code. crossRepoTermScores already computes IDF, which demotes any term ' +
        'appearing in every repo — derived from the actual corpus, not hand-maintained.',
    ).not.toMatch(/DOMAIN_STOPWORDS/);
  });

  it('names no client repository, product or industry noun', () => {
    expect(src).not.toMatch(/gotransit|upexpress|metrolinx|c365|contentstack/i);
  });
});
