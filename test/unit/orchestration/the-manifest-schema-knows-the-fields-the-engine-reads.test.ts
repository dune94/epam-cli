/**
 * THE SCHEMA KNOWS EVERY FIELD THE ENGINE ACTUALLY READS.
 *
 * Found 2026-09-05 while checking that a dependency override no longer pointed at the real
 * codelines: metrolinx's dependency-check.json does not validate at all.
 *
 *     schema: 8 validation errors for DependencyManifest
 *     buildArtifactDirs
 *       Extra inputs are not permitted [type=extra_forbidden, ...]
 *
 * Eight fields — buildArtifactDirs, indexFileNames, moduleConfigGlob, moduleAliasPath, moduleRoots,
 * autoInstall, dependencySensitiveConfigFiles, coupledFilePairs — are read by the engine today:
 *
 *     plugins/dependency-scan-plugin.js   buildArtifactDirs, indexFileNames,
 *                                         moduleConfigGlob, moduleAliasPath
 *     scripts/claude.sh                   moduleRoots, autoInstall, coupledFilePairs
 *     lib/eslint-baseline-gate.sh         moduleRoots
 *     lib/coupled-pair-gate.sh            coupledFilePairs
 *     lib/plan-fidelity-gate.sh           dependencySensitiveConfigFiles
 *     detective-rerun-step.js             dependencySensitiveConfigFiles
 *
 * So the FILE is right and the SCHEMA is stale. `model_config = {"extra": "forbid"}` then rejects
 * real, live configuration.
 *
 * WHY IT MATTERS MORE THAN A TIDY-UP: validation aborts on the schema error before reaching any of
 * the semantic checks below it — the importPattern compile, the manifestFile existence check, and
 * the localSourcePath check that exists to stop an override pointing into the wrong codeline tree.
 * The reviewer this file's docstring describes ("checks the manifest against the REAL codeline,
 * not against itself") has therefore been INERT for metrolinx, the only brownfield project.
 * Identical on v1.38, so this predates today's work.
 *
 * `extra: forbid` stays. Its stated purpose — "a mistyped field must fail, not vanish" — is
 * exactly right, and it is why the drift was visible at all. The fix is to declare what is real,
 * not to stop checking. Both ends are asserted: the live fields validate, and a genuine typo is
 * still refused.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const PY = join(REPO, 'orchestrations/scripts/.venv/bin/python');
const SCHEMA_PY = join(REPO, 'orchestrations/scripts/lib/manifest_schema.py');
const PROJECTS = join(REPO, 'orchestrations/projects');

function validate(manifest: unknown, repo = REPO) {
  const r = spawnSync(PY, [SCHEMA_PY, '--validate', '--repo', repo], {
    encoding: 'utf8', input: JSON.stringify(manifest), timeout: 60_000,
    env: { ...process.env, JIRA_CODELINE_ROOT: process.env.JIRA_CODELINE_ROOT || REPO },
  });
  const out = (r.stdout || '').trim();
  return (out ? JSON.parse(out) : { verdict: 'fail', issues: [`no output: ${r.stderr}`] }) as
    { verdict: string; issues: string[] };
}

const schemaIssues = (v: { issues: string[] }) =>
  v.issues.filter((i) => /^schema:/.test(i) || /extra_forbidden/.test(i));

/**
 * THE FIELDS ARE DISCOVERED, NOT LISTED. Read from what each project actually declares, so a
 * ninth field added to a manifest tomorrow is caught by this test rather than by another silently
 * inert reviewer.
 */
function declaredByProjects(): string[] {
  const names = new Set<string>();
  for (const p of readdirSync(PROJECTS)) {
    const f = join(PROJECTS, p, 'dependency-check.json');
    if (!existsSync(f)) continue;
    for (const k of Object.keys(JSON.parse(readFileSync(f, 'utf8')))) {
      if (!k.startsWith('_') && !k.startsWith('$')) names.add(k);
    }
  }
  return [...names];
}

describe('every project\'s real manifest validates', () => {
  const projects = readdirSync(PROJECTS)
    .filter((p) => existsSync(join(PROJECTS, p, 'dependency-check.json')));

  it('there are projects to check — otherwise the cases below are vacuous', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  it.each(projects)('%s: no field is rejected as unknown', (p) => {
    const manifest = JSON.parse(
      readFileSync(join(PROJECTS, p, 'dependency-check.json'), 'utf8'));
    const v = validate(manifest);
    expect(schemaIssues(v), [
      `${p}'s manifest carries fields the schema does not declare, so validation aborts before`,
      'reaching the semantic checks — the importPattern compile, the manifestFile existence check,',
      'and the localSourcePath check that keeps an override out of the wrong codeline tree. The',
      'reviewer is inert for this project.',
      `issues: ${JSON.stringify(v.issues).slice(0, 400)}`,
    ].join('\n')).toEqual([]);
  });
});

describe('the schema declares what the engine reads', () => {
  const BASE = {
    manifestFile: 'package.json',
    manifestKeys: ['dependencies'],
    scanFileExtensions: ['.ts'],
    importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
    installCommand: 'npm install --no-save {package}',
    vendorDirs: ['node_modules'],
  };

  it.each(declaredByProjects().filter((k) => !Object.keys(BASE).includes(k)))(
    'accepts %s', (field) => {
      // Driven with the REAL value a project uses, so the declared TYPE is exercised and not just
      // the name — a field declared with the wrong type would still be rejected here.
      const dc = JSON.parse(readFileSync(
        join(PROJECTS, 'metrolinx/dependency-check.json'), 'utf8'));
      const value = dc[field] !== undefined ? dc[field]
        : JSON.parse(readFileSync(join(PROJECTS, 'skyscanner/dependency-check.json'), 'utf8'))[field];
      if (value === undefined) return;                    // not declared by these two; nothing to do
      const v = validate({ ...BASE, [field]: value });
      expect(schemaIssues(v),
        `${field} is read by the engine but the schema rejects it: ${JSON.stringify(v.issues).slice(0, 300)}`)
        .toEqual([]);
    });

  it('THE OTHER END — a genuinely mistyped field is still refused', () => {
    // extra: forbid exists so "a mistyped field must fail, not vanish". Declaring the real fields
    // must not turn that off; a typo that silently vanishes is how a setting looks applied and
    // does nothing.
    const v = validate({ ...BASE, buildArtefactDirs: ['dist'] });   // British spelling: a typo
    expect(v.verdict, [
      'a misspelled field was accepted, so it would sit in the manifest doing nothing while the',
      'operator believes it is configured. extra: forbid has been weakened.',
    ].join('\n')).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/buildArtefactDirs|extra/i);
  });

  it('and a real field given the WRONG TYPE is refused', () => {
    const v = validate({ ...BASE, autoInstall: 'yes' });            // string, not boolean
    expect(v.verdict, 'a field was declared loosely enough to accept any type')
      .toBe('fail');
  });

  it('all the new fields are OPTIONAL — a manifest without them still validates', () => {
    // mock3 and skyscanner declare far fewer fields; making any of these required would break
    // every project that has not opted in.
    expect(schemaIssues(validate(BASE)),
      'the minimal manifest stopped validating, so the new fields were made required')
      .toEqual([]);
  });
});
