/**
 * DET-1, AT THE SEAM: THE SURVEY RUNS, IS PERSISTED, AND REACHES THE MINT.
 *
 * A survey nothing consumes is a report. These tests execute the real seam against a stub
 * runner and assert on the artefacts it produces — the survey file written to disk, and the
 * prompt actually delivered to the proposer.
 *
 * The separation is asserted in the PROMPT too, not only in the data structure: findings and
 * the team recommendation must arrive as distinguishable claims, because the failure mode is
 * a model reading "this codeline needs an investigator" as something discovered about the code.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CODELINES = [
  { name: 'gotransit', path: '/estate/gotransit' },
  { name: 'upexpress', path: '/estate/upexpress' },
];

const TICKETS = [{
  id: 'AMSD-2041', jiraKey: 'AMSD-2041',
  title: 'Enable draft preview for editors',
  description: 'Editors cannot see unpublished entries before they go live.',
}];

const SURVEY_ANSWER = JSON.stringify({
  codelines: [
    { codeline: 'gotransit', state: 'in_scope', evidence: 'listed src/preview and found a route module',
      surfaces: ['src/preview'] },
    { codeline: 'upexpress', state: 'no_work_found', evidence: 'searched the tree, no preview surface exists' },
  ],
  recommendedInvestigators: [
    { codeline: 'gotransit', focus: 'the preview routing surface', why: 'it is the only codeline carrying one' },
  ],
});

/** Captures the prompt it is handed, then answers with the given tagged payload. */
function runner(tag: string, answer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'survey-run-')); dirs.push(dir);
  const capture = join(dir, 'prompt.txt');
  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\n` +
    `cat <<'ANSWER'\n<${tag}>${answer}</${tag}>\nANSWER\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], capture };
}

function logDir() {
  const d = mkdtempSync(join(tmpdir(), 'survey-log-')); dirs.push(d); return d;
}

async function survey(answer = SURVEY_ANSWER) {
  const dir = logDir();
  const r = runner('ESTATE_SURVEY', answer);
  delete process.env.SPEC_MODE_PROVIDER;
  const res = await spec.surveyEstate({
    promptExec: r, tickets: TICKETS, referencedDocs: [], codelines: CODELINES,
    logDir: dir, repoPath: dir,
  });
  return { res, dir, prompt: existsSync(r.capture) ? readFileSync(r.capture, 'utf8') : '' };
}

describe('the fixture is real', () => {
  it('the seam runs and produces a non-empty prompt and a parsed survey', async () => {
    const { res, prompt } = await survey();
    expect(prompt.length, 'no prompt reached the surveyor — every assertion below is vacuous')
      .toBeGreaterThan(200);
    expect(res.ran).toBe(true);
    expect(res.codelines.length).toBe(2);
  }, 60_000);
});

describe('the surveyor is told to open the repositories, and told its limits', () => {
  it('every codeline in scope, and where it is checked out, reaches the agent', async () => {
    const { prompt } = await survey();
    expect(prompt).toContain('gotransit');
    expect(prompt).toContain('/estate/upexpress');
  }, 60_000);

  it('the ticket reaches it — the work is what it is surveying for', async () => {
    const { prompt } = await survey();
    expect(prompt).toContain('AMSD-2041');
    expect(prompt).toContain('unpublished entries');
  }, 60_000);

  it('it is told that "looked and found nothing" is an answer, not a non-answer', async () => {
    const { prompt } = await survey();
    expect(prompt).toMatch(/no_work_found/);
    expect(prompt).toMatch(/not the same as not having looked/i);
  }, 60_000);

  it('it is told not to name files to change — that is the investigator\'s job', async () => {
    const { prompt } = await survey();
    expect(prompt).toMatch(/never a file to edit/i);
  }, 60_000);
});

describe('REGRESSION 2026-08-08: the live run returned prose and lost a good investigation', () => {
  // The surveyor did excellent work — it opened all three repos, read every manifest, searched
  // for live-preview wiring and spotted that all three share cx-shared at three DIFFERENT
  // versions. Then it answered in markdown and runAgentForJson discarded every word:
  //   Failed to parse JSON for tag ESTATE_SURVEY: Unexpected token '#', "# AMSD-204"...
  // The proposal prompt that DOES work ends with an explicit "respond with ONLY valid JSON"
  // contract. This one ended with prose instructions and no contract at all.
  it('the prompt ends with an explicit JSON-only output contract', async () => {
    const { prompt } = await survey();
    expect(prompt).toMatch(/ONLY valid JSON/i);
    expect(prompt, 'nothing told the agent not to wrap its answer in markdown').toMatch(/no markdown fences/i);
  }, 60_000);

  it('the contract names the exact keys the schema requires', async () => {
    const { prompt } = await survey();
    expect(prompt).toContain('"codelines"');
    expect(prompt).toContain('"recommendedInvestigators"');
    expect(prompt).toMatch(/in_scope/);
  }, 60_000);
});

describe('REGRESSION 2026-08-08: the survey was handed indices instead of dependencies', () => {
  // declaredDependencies is a flat ARRAY of package names — mintProjectAgents renders it as
  // one, this rendered Object.entries() of it and produced "- 0: (none declared)" through
  // "- 9:". The surveyor was given ZERO dependency facts about an estate whose entire ticket
  // turns on which CMS packages are declared.
  const DEPS = ['contentstack', '@contentstack/utils', 'next', '@metrolinx/cx-shared'];

  it('dependency NAMES reach the prompt, not array indices', async () => {
    const dir = logDir();
    const r = runner('ESTATE_SURVEY', SURVEY_ANSWER);
    await spec.surveyEstate({
      promptExec: r, tickets: TICKETS, referencedDocs: [], codelines: CODELINES,
      declaredDependencies: DEPS, logDir: dir, repoPath: dir,
    });
    const prompt = readFileSync(r.capture, 'utf8');

    expect(prompt).toContain('contentstack');
    expect(prompt).toContain('@metrolinx/cx-shared');
    expect(prompt, 'the array was enumerated by index — the surveyor got no dependency facts')
      .not.toMatch(/^- \d+: /m);
  }, 60_000);
});

describe('REGRESSION 2026-08-08: fetched document bodies never reached the surveyor', () => {
  // A fetched doc is {url, fetchStatus, path} — the TEXT is on disk at `path`, and there are
  // no quotes and no inline body. The mint reads the file; the survey did not, so both vendor
  // documents arrived as a URL and a blank line. Empty documents are precisely what caused a
  // mint to invent a vendor on 2026-08-07.
  it('document text is read from disk and reaches the prompt', async () => {
    const dir = logDir();
    const docPath = join(dir, 'doc1.txt');
    writeFileSync(docPath, 'the options object accepts a live_preview key and a preview token');
    const r = runner('ESTATE_SURVEY', SURVEY_ANSWER);
    await spec.surveyEstate({
      promptExec: r, tickets: TICKETS,
      referencedDocs: [{ url: 'https://vendor.example/docs', fetchStatus: 'fetched', path: docPath }],
      codelines: CODELINES, logDir: dir, repoPath: dir,
    });
    const prompt = readFileSync(r.capture, 'utf8');

    expect(prompt, 'the document arrived as a URL and a blank line').toContain('live_preview');
    expect(prompt).toContain('vendor.example');
  }, 60_000);

  it('a document with no readable text says so rather than rendering blank', async () => {
    const dir = logDir();
    const r = runner('ESTATE_SURVEY', SURVEY_ANSWER);
    await spec.surveyEstate({
      promptExec: r, tickets: TICKETS,
      referencedDocs: [{ url: 'https://vendor.example/gone', fetchStatus: 'fetched' }],
      codelines: CODELINES, logDir: dir, repoPath: dir,
    });
    expect(readFileSync(r.capture, 'utf8')).toMatch(/no readable text/);
  }, 60_000);
});

describe('the survey is persisted', () => {
  it('estate-survey.json is written at generation time', async () => {
    // What the roster was grounded in must outlive the process that produced it, or the pause
    // has nothing to show and a later run cannot tell "cleared" from "skipped".
    const { dir, res } = await survey();
    const f = join(dir, 'estate-survey.json');
    expect(existsSync(f), 'the survey existed only in memory').toBe(true);
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    expect(rec.codelines).toEqual(res.codelines);
    expect(rec.recommendedInvestigators.length).toBe(1);
  }, 60_000);
});

describe('a survey that fails does not stop the run', () => {
  it('an unusable answer leaves every codeline stated, never silently dropped', async () => {
    const { res } = await survey(JSON.stringify({}));
    expect(res.codelines.map((c: any) => c.state)).toEqual(['not_investigated', 'not_investigated']);
  }, 60_000);

  it('no codelines in scope is not an error', async () => {
    const res = await spec.surveyEstate({
      promptExec: runner('ESTATE_SURVEY', SURVEY_ANSWER), tickets: TICKETS,
      codelines: [], logDir: logDir(), repoPath: '',
    });
    expect(res.ran).toBe(false);
    expect(res.codelines).toEqual([]);
  }, 60_000);
});

describe('the survey reaches the mint as two distinguishable things', () => {
  async function mintPrompt(estateSurvey: unknown) {
    const dir = logDir();
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANONICAL' }));
    const r = runner('PROJECT_AGENTS', JSON.stringify({ proposedAgents: [] }));
    delete process.env.SPEC_MODE_PROVIDER;
    await spec.mintProjectAgents({
      promptExec: r, tickets: TICKETS, referencedDocs: [], codelines: CODELINES,
      estateSurvey, profilesPath, agentsDir: dir, logDir: dir, repoPath: dir,
    });
    return existsSync(r.capture) ? readFileSync(r.capture, 'utf8') : '';
  }

  it('the findings reach the proposer with their evidence and state', async () => {
    const { res } = await survey();
    const prompt = await mintPrompt(res);
    expect(prompt).toContain('no preview surface exists');
    expect(prompt).toMatch(/gotransit: in_scope/);
    expect(prompt).toMatch(/upexpress: no_work_found/);
  }, 60_000);

  it('the team recommendation is marked as a recommendation, not as a finding', async () => {
    const { res } = await survey();
    const prompt = await mintPrompt(res);
    expect(
      prompt,
      'a recommendation about the team is presented as something discovered about the code',
    ).toMatch(/recommendation about the TEAM/);
    expect(prompt).toContain('the preview routing surface');
  }, 60_000);

  it('the proposer is warned not to read not_investigated as "work is needed here"', async () => {
    const { res } = await survey(JSON.stringify({ codelines: [], recommendedInvestigators: [] }));
    const prompt = await mintPrompt(res);
    expect(prompt).toMatch(/not_investigated/);
    expect(prompt).toMatch(/not established either way|do not treat either as confirmation/i);
  }, 60_000);

  it('no survey at all leaves the block out entirely rather than emitting an empty one', async () => {
    const prompt = await mintPrompt(undefined);
    expect(prompt).not.toMatch(/WHAT A SURVEY OF THESE REPOSITORIES/);
  }, 60_000);
});
