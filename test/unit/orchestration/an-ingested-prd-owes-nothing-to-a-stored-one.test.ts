/**
 * AN INGESTED PRD IS BUILT FROM THE TRACKER AND THE PROJECT'S CONFIG — NOTHING ELSE.
 *
 * The Jira ingest did not build a PRD. It filled a stored TEMPLATE, prd.canonical.json, and spread
 * the whole file into the result:
 *
 *     const synthesizedPrd = { ...template, id, title, ..., stories };
 *     const project        = { ...template.project };
 *
 * So every value in that stored file governed every run. metrolinx's carried
 * `outputDirs:[cdts]` — one codeline, frozen in by hand on 2026-07-25 to unblock a failing launch
 * — and because resolve-codeline-scope.sh stands aside when a scope is already declared, DISCOVERY
 * NEVER RAN. Every run since was scoped to one repository whatever the ticket said. The same file
 * had already been cleaned twice for the same class of contamination: another project's stack
 * (b5b02e3) and eight fabricated acceptance criteria (c446591).
 *
 * A file that survives between runs and shapes them is a run inheriting a previous run's
 * conclusions. The tracker is the source of the work and the project's config is the source of its
 * identity; a third, stored, hand-edited source is where a run's output goes to become a premise.
 *
 * NOTE ON THE WORD. "canonical" names three unrelated things here: this stored template, the run's
 * own merged PRD (story-merge.js), and "pre-spec-pass" (prd-is-canonical.py). Only the first is
 * under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SYNTH = join(ROOT, 'orchestrations/scripts/synthesize-prd-from-jira.js');

const ENV = { ...process.env };
let work = '';

beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'synth-')); });
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  process.env = { ...ENV };
});

/** The AC-gate classification the synthesiser consumes, in its real shape. */
const classification = () => {
  const p = join(work, 'ac-classification.json');
  // A TOP-LEVEL ARRAY, which is what the AC gate writes and the synthesiser reads.
  writeFileSync(p, JSON.stringify([{
    storyId: 'ABC-1',
    jiraKey: 'ABC-1',
    title: 'a real ticket title',
    description: 'what the ticket asks for',
    verdict: 'pass',
    acceptanceCriteria: ['AC1: something observable'],
    codeline: 'somecodeline',
  }]));
  return p;
};

const synthesise = (env: Record<string, string> = {}) => {
  const out = join(work, 'prd.json');
  execFileSync(process.execPath, [SYNTH, '--classifications', classification(), '--out', out], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_NAME: 'someproject',
      JIRA_PROJECT_KEY: 'ABC',
      ...env,
    },
  });
  return JSON.parse(readFileSync(out, 'utf8'));
};

describe('the synthesiser needs no stored template', () => {
  it('builds a PRD with no --template at all', () => {
    const prd = synthesise();
    expect(prd.stories, 'no stories were synthesised').toHaveLength(1);
    expect(prd.stories[0].jiraKey).toBe('ABC-1');
  });

  it('takes the project identity from the project config, not from a file', () => {
    const prd = synthesise({ PROJECT_NAME: 'anotherproject', JIRA_PROJECT_KEY: 'XYZ' });
    expect(prd.project.name).toBe('anotherproject');
    expect(prd.sourceProject).toBe('XYZ');
    expect(prd.source).toBe('jira');
  });

  it('declares NO codeline scope — discovery fills that, and a stored one pre-empted it', () => {
    const prd = synthesise();
    expect(prd.project.outputDirs || [], 'a scope was declared before discovery ran').toEqual([]);
    expect(prd.project.outputDir, 'a single codeline was declared before discovery ran').toBeFalsy();
  });

  it('declares NO project-level stack — stack is a per-codeline fact', () => {
    // metrolinx is 33 repositories: Next.js sites, .NET sites, API services. One stack block
    // cannot be true of them, and get_project_context() flattens it into every agent's prompt.
    const prd = synthesise();
    expect(prd.project.stack, 'a stack was asserted for a whole estate').toBeFalsy();
  });

  it('starts its iteration count fresh, because the PRD does not survive the run', () => {
    const prd = synthesise();
    expect(prd.currentIteration).toBe(1);
  });
});

describe('nothing in the pipeline reads a stored PRD template', () => {
  const pipelineFiles = [
    'orchestrations/scripts/ingest-jira-tickets.sh',
    'orchestrations/scripts/synthesize-prd-from-jira.js',
    'orchestrations/scripts/pre-run-reset.sh',
    'orchestrations/scripts/preflight-check.sh',
  ];

  it('no ingest, synthesis, reset or preflight path names prd.canonical.json', () => {
    const offenders: string[] = [];
    for (const f of pipelineFiles) {
      const src = readFileSync(join(ROOT, f), 'utf8').split('\n')
        .filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      if (/prd\.canonical\.json/.test(src)) offenders.push(f);
    }
    expect(offenders, `still reading a stored template: ${offenders.join(', ')}`).toEqual([]);
  });

  it('and no project ships one', () => {
    const dirs = execFileSync('ls', [join(ROOT, 'orchestrations/projects')], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(dirs.length, 'no projects found — this test is checking nothing').toBeGreaterThan(0);
    const withTemplate = dirs.filter(
      (d) => existsSync(join(ROOT, 'orchestrations/projects', d, 'prd.canonical.json')));
    expect(withTemplate, `projects still storing a PRD template: ${withTemplate.join(', ')}`)
      .toEqual([]);
  });
});
