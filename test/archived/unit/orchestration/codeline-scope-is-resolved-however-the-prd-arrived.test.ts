/**
 * THE REQUIREMENT: a project with more than one codeline runs its codelines as lanes, whatever
 * produced its PRD.
 *
 * Codeline discovery is currently invoked from exactly one place — ingest-jira-tickets.sh, inside
 * the JIRA_PIPELINE=1 branch. A project whose PRD is authored rather than ingested never reaches
 * it, so project.outputDirs is never populated, the entry dispatch counts 0 codelines, and the run
 * silently collapses to a single unnamed lane. The mint then falls through
 * `try { read discovery } catch {}` to `add('', repoArg)` and reports success.
 *
 * These tests are written against the REQUIREMENT, not the behaviour. Asserting the current
 * single-lane resolution would pass today and ratify the defect as intent.
 *
 * Nothing here names a project. The fixtures are built from scratch, and the rule under test is
 * "scope undeclared + a codeline root configured ⇒ scope gets resolved" — which is true for every
 * project the engine will ever see.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'codeline-scope-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** Two throwaway git repos under one root — the shape any brownfield project presents. */
function twoCodelineRoot(): string {
  const root = join(work, 'codelines');
  for (const name of ['alpha-service', 'beta-service']) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\nHandles the ${name.split('-')[0]} domain.\n`);
    spawnSync('git', ['-C', dir, 'init', '--quiet']);
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-m', 'init', '--quiet'],
      { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  }
  return root;
}

/** An AUTHORED PRD: stories carrying their own codelines, and no project.outputDirs. */
function authoredPrd(): string {
  const p = join(work, 'prd.json');
  writeFileSync(p, JSON.stringify({
    title: 'authored',
    project: { name: 'authored-project' },
    stories: [
      {
        id: 'W-1', jiraKey: 'W-1', title: 'Alpha rounds the wrong way',
        description: 'The alpha-service rounds a boundary value down instead of up.',
        components: ['alpha-service'], codelines: ['alpha-service'],
        status: 'pending', acceptanceCriteria: ['the boundary rounds up'],
      },
      {
        id: 'W-2', jiraKey: 'W-2', title: 'Beta omits the final element',
        description: 'The beta-service renderer drops the last element of the list.',
        components: ['beta-service'], codelines: ['beta-service'],
        status: 'pending', acceptanceCriteria: ['every element renders'],
      },
    ],
    implementationOrder: { core: ['W-1', 'W-2'] },
  }, null, 2));
  return p;
}


/**
 * Discovery is TWO agents, not one: a vocabulary agent derives which terms carry selection signal,
 * then the matcher chooses repositories. Both go through ai-run.sh, so one stub answers both by
 * looking at which one is asking.
 *
 * --dry-run is NOT the lever here. It skips the vocabulary agent and falls back to
 * selectBestCandidate, which can only ever return ONE repository and refuses outright when the
 * work names more than one product area — so it cannot express the multi-codeline case this
 * requirement is about.
 */
function stubAiRun(root: string): string {
  const p = join(work, 'stub-ai-run.sh');
  writeFileSync(p, [
    '#!/usr/bin/env bash',
    '_p=""',
    'for a in "$@"; do [ -f "$a" ] && _p="$a"; done',
    '_text="$( [ -n "$_p" ] && cat "$_p" || cat )"',
    "if printf '%s' \"$_text\" | grep -qi 'DISCOVERY_VOCABULARY'; then",
    "  echo '<DISCOVERY_VOCABULARY>'",
    `  echo '{"blacklist":[{"term":"the","reason":"stopword","kind":"noise"},{"term":"service","reason":"shared by every candidate","kind":"noise"}],"whitelist":[{"term":"alpha","reason":"names a candidate"},{"term":"beta","reason":"names a candidate"}]}'`,
    "  echo '</DISCOVERY_VOCABULARY>'",
    'else',
    `  echo '{"codelines":[{"name":"alpha-service","path":"${root}/alpha-service","reason":"named in components"},{"name":"beta-service","path":"${root}/beta-service","reason":"named in components"}]}'`,
    'fi',
  ].join('\n'));
  spawnSync('chmod', ['+x', p]);
  return p;
}

describe('codeline scope is resolved however the PRD arrived', () => {
  it('the engine has a scope resolver that does not live behind the Jira branch', () => {
    // The structural half of the requirement. Discovery reachable from ONE caller, and that caller
    // inside `if JIRA_PIPELINE=1`, is the whole defect — no fixture can work around it.
    const callers = spawnSync('grep', [
      '-rl', '--include=*.sh', '--include=*.js', 'codeline-discovery.js', SCRIPTS,
    ], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      .filter((f) => !f.endsWith('lib/codeline-discovery.js'))
      .filter((f) => {
        // Only files that INVOKE it, not ones that mention it in prose.
        const src = readFileSync(f, 'utf8');
        return /(?:node|NODE_BIN[^\n]*)["' ][^\n]*codeline-discovery\.js|require\([^)]*codeline-discovery/.test(src);
      });

    expect(callers.length,
      `codeline-discovery.js is invoked from ${callers.length} place(s): ${callers.join(', ')}. `
      + 'While its only caller is the Jira ingest, a project with an authored PRD can never resolve '
      + 'its codelines and silently runs as one unnamed lane.',
    ).toBeGreaterThan(1);
  });

  it('resolves scope for an authored PRD, writing outputDirs the dispatch can count', () => {
    const prd = authoredPrd();
    const root = twoCodelineRoot();
    const resolver = join(SCRIPTS, 'resolve-codeline-scope.sh');

    expect(existsSync(resolver),
      'no engine stage resolves codeline scope outside the Jira branch').toBe(true);

    const r = spawnSync('bash', [resolver, '--prd', prd, '--root', root], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EPAM_BROWNFIELD: '1',
        CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stubAiRun(root),
      },
    });
    expect(r.status, `resolver exited ${r.status}: ${r.stderr}`).toBe(0);

    const after = JSON.parse(readFileSync(prd, 'utf8'));
    const dirs = (after.project || {}).outputDirs || [];
    expect(dirs.length,
      'the resolver did not populate project.outputDirs, so the entry dispatch still counts 0 '
      + 'and the run collapses to a single lane').toBe(2);
    for (const d of dirs) {
      // The NAME is derived from the repository, never taken from the model's answer — a
      // codeline name is a primary key. So assert it exists and that its path is real, not that
      // it equals the string the model happened to emit.
      expect(d.codeline, 'an outputDirs entry with no codeline name').toBeTruthy();
      expect(existsSync(d.path), `outputDirs path does not exist: ${d.path}`).toBe(true);
    }
  });

  it('leaves an already-declared scope alone', () => {
    // Resolution fills a GAP. A project that declares its codelines has answered the question, and
    // re-answering it would let discovery overrule an operator's explicit scope.
    const prd = authoredPrd();
    const declared = [{ codeline: 'declared-one', path: work }];
    const doc = JSON.parse(readFileSync(prd, 'utf8'));
    doc.project.outputDirs = declared;
    writeFileSync(prd, JSON.stringify(doc, null, 2));

    const resolver = join(SCRIPTS, 'resolve-codeline-scope.sh');
    if (!existsSync(resolver)) return;                    // covered by the test above

    const root = twoCodelineRoot();
    spawnSync('bash', [resolver, '--prd', prd, '--root', root], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EPAM_BROWNFIELD: '1',
        CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stubAiRun(root),
      },
    });

    expect(JSON.parse(readFileSync(prd, 'utf8')).project.outputDirs,
      'the resolver overwrote a scope the project had already declared').toEqual(declared);
  });
});
