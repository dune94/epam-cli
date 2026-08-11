/**
 * A STORY THAT ADDS A PACKAGE ALMOST NEVER ONLY ADDS A PACKAGE.
 *
 * Live AMSD-2041/gotransit, 2026-08-11. @contentstack/live-preview-utils is ESM.
 * jest.config.js hard-codes which node_modules packages get transpiled. Jest died on
 * `export` on every attempt, the test gate went RED every attempt, and the run was lost —
 * on a one-line config change. The generated code was fine.
 *
 * NOBODY OWNED THE FILE. The detective enumerates CODE fix sites from the ticket.
 * Verification criteria are behavioural by design — all four on this story were about
 * live-preview rendering and auth, correctly so. Nothing connected "this story adds a
 * package" to "this build config must be revisited".
 *
 * And it was not a permissions problem: jest.config.js was -rw-r--r-- on the story branch
 * the entire run. THE WRITER WAS NOT BLOCKED, IT WAS UNGUIDED. Fixing this by widening
 * write access would be the wrong lever.
 *
 * WHICH files are dependency-sensitive is a STACK FACT — jest here, something else for the
 * next project — so it is DECLARED in the project's dependency-check.json and read through
 * the plugin. These tests assert the derivation, and that it stays honest about what it
 * does not know.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const PLUGIN = join(ROOT, 'orchestrations/plugins/dependency-scan-plugin.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const plugin = require(PLUGIN);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project config dir declaring a complete scan manifest, plus whatever extra keys given. */
function projectConfig(extra: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'depcfg-')); dirs.push(d);
  writeFileSync(join(d, 'dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json',
    manifestKeys: ['dependencies'],
    scanFileExtensions: ['.ts'],
    importPattern: "from\\s+['\"]([^.][^'\"]*)['\"]",
    vendorDirs: ['node_modules'],
    ...extra,
  }, null, 2));
  return d;
}

describe('the declaration is read from the PROJECT, never inferred by the engine', () => {
  it('returns the declared files', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js', 'tsconfig.json'] });
    const r = plugin.dependencySensitiveConfigFiles('/nonexistent', { EPAM_PROJECT_CONFIG_DIR: d });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(['jest.config.js', 'tsconfig.json']);
  });

  it('a DIFFERENT project declaring different files needs no engine change', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['vite.config.mjs', 'pyproject.toml'] });
    const r = plugin.dependencySensitiveConfigFiles('/nonexistent', { EPAM_PROJECT_CONFIG_DIR: d });
    expect(r.files).toEqual(['vite.config.mjs', 'pyproject.toml']);
  });

  it('UNDECLARED IS UNKNOWN — never an empty list', () => {
    // "We cannot tell which build-config files a dependency affects" must not render as
    // "there are none". That collapse is how the previous scanner produced a confident
    // wrong answer with its config missing.
    const d = projectConfig({});
    const r = plugin.dependencySensitiveConfigFiles('/nonexistent', { EPAM_PROJECT_CONFIG_DIR: d });
    expect(r.ok, 'absent silently became "no files"').toBe(false);
    expect(r.declared).toBe(false);
    expect(r.reason).toMatch(/not declared/i);
  });

  it('the key is NOT required — a project may legitimately have none', () => {
    // It must not join REQUIRED_KEYS, or every existing project's scan breaks.
    expect(plugin.REQUIRED_KEYS).not.toContain(plugin.DEPENDENCY_SENSITIVE_KEY);
  });

  it('a malformed declaration is refused, not coerced', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: 'jest.config.js' });
    const r = plugin.dependencySensitiveConfigFiles('/nonexistent', { EPAM_PROJECT_CONFIG_DIR: d });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/must be an array/);
  });
});

describe('THE CANDIDATE CARRIES NEITHER VERDICT', () => {
  /**
   * The writer's enforcement gate selects sites where fixVerified === true AND
   * changeRequired !== false, then demands a diff for each. So a candidate that claimed
   * either verdict would force the writer to edit a file on the strength of a guess, and a
   * candidate stamped changeRequired:false would be exempted before anyone looked.
   */
  const step = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const src = require('node:fs').readFileSync(join(ROOT, 'orchestrations/scripts/detective-rerun-step.js'), 'utf8');
    return src;
  };

  const sitesWithPackage = [
    { file: 'src/pages/_app.tsx', changeRequired: true, fixVerified: true, requiredPackages: ['pkg-a'] },
    { file: 'src/lib/x.ts', changeRequired: false, fixVerified: true, requiredPackages: [] },
  ];

  /** Run the real derivation by loading the module's function through a tiny shim. */
  function derive(sites: unknown[], configDir: string) {
    const src = step();
    const start = src.indexOf('function dependencyConfigCandidates');
    expect(start, 'derivation function not found — the test is stale').toBeGreaterThan(-1);
    let depth = 0; let end = start;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${src.slice(start, end)}; return dependencyConfigCandidates;`)();
    return fn(sites, '/nonexistent', { EPAM_PROJECT_CONFIG_DIR: configDir }, plugin);
  }

  it('emits a candidate when a fix site requires a package', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js'] });
    const out = derive(sitesWithPackage, d);
    expect(out.candidates.map((c: any) => c.file)).toEqual(['jest.config.js']);
  });

  it('changeRequired is ABSENT — not false, not true', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js'] });
    const c = derive(sitesWithPackage, d).candidates[0];
    expect('changeRequired' in c, 'a verdict was invented for an uninvestigated file').toBe(false);
  });

  it('fixVerified is ABSENT — the detective has not confirmed this site', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js'] });
    const c = derive(sitesWithPackage, d).candidates[0];
    expect('fixVerified' in c, 'claiming verification would push it into the enforcement gate').toBe(false);
  });

  it('the candidate states WHY it is a candidate, naming the package', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js'] });
    const c = derive(sitesWithPackage, d).candidates[0];
    expect(c.reason).toContain('pkg-a');
    expect(c.reason).toMatch(/investigate/i);
  });

  it('NO package required -> NO candidates', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js'] });
    const out = derive([{ file: 'a.ts', changeRequired: true, requiredPackages: [] }], d);
    expect(out.candidates).toEqual([]);
  });

  it('a file already prescribed is not duplicated', () => {
    const d = projectConfig({ dependencySensitiveConfigFiles: ['jest.config.js'] });
    const out = derive([
      { file: 'jest.config.js', changeRequired: true, fixVerified: true, requiredPackages: ['pkg-a'] },
    ], d);
    expect(out.candidates).toEqual([]);
  });

  it('undeclared config yields NO candidates but DOES yield a reported reason', () => {
    const d = projectConfig({});
    const out = derive(sitesWithPackage, d);
    expect(out.candidates).toEqual([]);
    expect(out.note, 'the gap was swallowed instead of reported').toMatch(/not declared/i);
    expect(out.packages, 'the packages were still detected').toEqual(['pkg-a']);
  });
});

describe('the engine names no stack facts', () => {
  it('detective-rerun-step.js does not name a test runner or config file', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const src = require('node:fs')
      .readFileSync(join(ROOT, 'orchestrations/scripts/detective-rerun-step.js'), 'utf8')
      .split('\n').filter((l: string) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const leak of ['jest.config', 'tsconfig.json', 'vite.config', 'babel.config', 'transformIgnorePatterns']) {
      expect(src, `'${leak}' is a stack fact and belongs in the project declaration`).not.toContain(leak);
    }
  });
});

describe('DERIVING MUST NOT REQUIRE RE-INVESTIGATING', () => {
  /**
   * The derivation reads requiredPackages off the prescription that already stands and needs
   * no LLM call. Coupling it to the re-investigation would mean the only way to add a
   * build-config candidate is to take a FRESH DRAW of the whole prescription.
   *
   * Live 2026-08-11: a re-run of AMSD-2041/gotransit replaced a correct prescription (3 sites
   * changeRequired:true, one carrying requiredPackages) with one asserting changeRequired:false
   * on ALL FIVE sites and no packages at all — and reported "every selected site carries
   * changeRequired", which was true, and all false. Reverted from the backup. A cheap
   * deterministic step must not be reachable only through an expensive nondeterministic one.
   */
  const STEP = join(ROOT, 'orchestrations/scripts/detective-rerun-step.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const src = () => require('node:fs').readFileSync(STEP, 'utf8');

  it('a standalone derive mode exists', () => {
    expect(src()).toContain('--derive-config-candidates');
  });

  it('the derive path makes NO detective call', () => {
    const s = src();
    const i = s.indexOf("hasFlag('--derive-config-candidates')");
    expect(i, 'derive mode not found').toBeGreaterThan(-1);
    // Everything from the flag check to its exit must not invoke the investigation.
    const block = s.slice(i, s.indexOf('process.exit(0);', i));
    expect(block, 'the cheap path calls the expensive one').not.toContain('runRerun');
    expect(block).not.toContain('await detective');
  });

  it('it leaves the PRD untouched when there is nothing to add', () => {
    const s = src();
    const i = s.indexOf("hasFlag('--derive-config-candidates')");
    const block = s.slice(i, s.indexOf('process.exit(0);', i));
    // A write with no change still rewrites the file and spawns a backup — noise that makes
    // real changes harder to spot in a folder that already accumulates them.
    expect(block).toMatch(/nothing to add/);
  });
});

describe('THE CANDIDATE MUST REACH THE LIST THE WRITER ACTUALLY READS', () => {
  /**
   * fixSiteAnalysis is NOT the writer's file list. build_implementation_prompt iterates
   * story_declared_files(), which reads technicalNotes.perCodeline[cl].files (falling back
   * to technicalNotes.files). fixSiteAnalysis only decides whether a DECLARED file gets its
   * content injected, and supplies the "- **file**: reason" line.
   *
   * So a candidate written to one and not the other is INVISIBLE. Verified live 2026-08-11
   * against the real PRD with the real shell functions: before this, jest.config.js was in
   * fixSiteAnalysis and absent from the writer's 12-file list. Caught by reading the prompt
   * builder rather than by a live run.
   */
  const stepSrc = () => require('node:fs')
    .readFileSync(join(ROOT, 'orchestrations/scripts/detective-rerun-step.js'), 'utf8');

  it('the derive path appends to technicalNotes, not only fixSiteAnalysis', () => {
    const s = stepSrc();
    const i = s.indexOf("hasFlag('--derive-config-candidates')");
    const block = s.slice(i, s.indexOf('process.exit(0);', i));
    expect(block).toContain('technicalNotes');
    expect(block, 'the per-codeline list is the one the writer reads first').toContain('perCodeline');
  });

  it('a missing technicalNotes list is REPORTED, not silently skipped', () => {
    const s = stepSrc();
    const i = s.indexOf("hasFlag('--derive-config-candidates')");
    const block = s.slice(i, s.indexOf('process.exit(0);', i));
    expect(block, 'the candidate would be undeliverable and nobody would be told')
      .toMatch(/WILL NOT reach the writer/);
  });

  it('the candidate carries an EMPTY function, never absent', () => {
    // The writer prompt renders "- **file** (`function`): reason" via jq, and jq treats a
    // MISSING .function as null — which renders a literal (`null`) to the model. Asserted
    // on the emitting source because `derive` is scoped to the sibling block above.
    const s = stepSrc();
    const i = s.indexOf('function dependencyConfigCandidates');
    const block = s.slice(i, s.indexOf('\n}', i));
    expect(block, "a candidate with no .function renders as (`null`) in the prompt")
      .toMatch(/function:\s*''/);
  });
});
