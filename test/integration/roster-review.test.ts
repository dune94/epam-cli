/**
 * THE ROSTER MUST HAVE AN ADVERSARY.
 *
 * Every other stage of this pipeline has one. The spec pass has a reviewer and a guard. The
 * writer has team-lead review and the gates. The verification criteria have a vocabulary guard
 * that refuses to run unarmed. The roster had none — and it decides who does all the later work
 * and what every one of those agents believes about the codebase.
 *
 * Two defects reached the pause from an unreviewed roster on 2026-08-07:
 *
 *  1. a brief prescribed `preview_token` in Contentstack.Stack(); the pinned contentstack
 *     3.15.3 does not contain that string anywhere;
 *  2. a brief called `@contentstack/utils` "the Live Preview Utils SDK" and told an implementer
 *     to call its init(). It is a general utilities package — no ContentstackLivePreview, no
 *     onEntryChange in it.
 *
 * The second shape is the more dangerous: a package that does not exist fails loudly at
 * install, while one that is installed and mislabelled resolves, builds, and does nothing.
 *
 * The reviewer is read-only and its verdict is DERIVED from its findings, never taken on its
 * word — a reviewer that lists defects and then declares the roster sound is exactly the
 * fail-open failure these gates exist to prevent.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const MINTED = [
  { name: 'an-engineer', kind: 'implementer', codeline: '' },
  { name: 'alpha-investigator', kind: 'investigator', codeline: 'alpha' },
];
const PROFILES = {
  'roster-reviewer': 'You are the roster reviewer. Falsify claims.',
  'an-engineer': 'Set preview_token inside Vendor.Stack(). Use @somevendor/utils as the Preview SDK.',
  'alpha-investigator': 'You read the alpha repository and report what is there.',
};

function runner(answer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rreview-')); dirs.push(dir);
  const capture = join(dir, 'prompt.txt');
  const sh = join(dir, 'r.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\ncat <<'A'\n<ROSTER_REVIEW>${answer}</ROSTER_REVIEW>\nA\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], capture, dir };
}

const FOUND = JSON.stringify({
  verdict: 'defects_found',
  findings: [{
    agent: 'an-engineer', severity: 'blocking',
    claim: 'Set preview_token inside Vendor.Stack()',
    checked: 'resolve_package_symbol preview_token in the installed vendor SDK',
    found: 'the symbol does not appear in the installed package',
    remedy: 'use the configuration key the pinned version actually exposes',
  }],
});

async function review(answer: string, toolGrant?: string) {
  const r = runner(answer);
  delete process.env.SPEC_MODE_PROVIDER;
  const res = await spec.reviewRoster({
    promptExec: r, minted: MINTED, profiles: PROFILES,
    codelines: [{ name: 'alpha', path: '/x/alpha', dependencies: ['@somevendor/utils'] }],
    tickets: [{
      id: 'T-1', jiraKey: 'T-1', title: 'a ticket', description: 'do the thing',
      components: ['ALPHA', 'BETA'],
      ticketLinks: [{ url: 'https://somevendor.example/docs/preview' }],
    }],
    referencedDocs: [{
      url: 'https://somevendor.example/docs/preview', fetchStatus: 'fetched',
      body: 'The vendor guide says to pass preview_token in the Stack options.',
    }],
    logDir: r.dir, repoPath: '', toolGrant,
  });
  return { res, prompt: existsSync(r.capture) ? readFileSync(r.capture, 'utf8') : '' };
}

describe('the reviewer is given the roster and the evidence', () => {
  it('every minted brief reaches it', async () => {
    const { prompt } = await review(FOUND, 'read_file,resolve_package_symbol');
    expect(prompt).toContain('an-engineer');
    expect(prompt).toContain('preview_token');
    expect(prompt, 'the investigator was not reviewed').toContain('alpha-investigator');
  }, 60_000);

  it('it sees what each codeline declares, so a claim can be tested', async () => {
    const { prompt } = await review(FOUND, 'read_file');
    expect(prompt).toContain('@somevendor/utils');
    expect(prompt).toContain('declares:');
  }, 60_000);

  it('it is told which tools it has, and to open the repositories', async () => {
    const { prompt } = await review(FOUND, 'read_file,resolve_package_symbol');
    expect(prompt).toMatch(/Your tools: read_file,resolve_package_symbol/);
    expect(prompt).toMatch(/Open the repositories/i);
  }, 60_000);

  it('with no tools it is told so, rather than asked to check what it cannot', async () => {
    const { prompt } = await review(FOUND, undefined);
    expect(prompt).toMatch(/NO tools on this call/);
    expect(prompt).not.toMatch(/Open the repositories/i);
  }, 60_000);
});

describe('the verdict is derived, never taken on the reviewer\'s word', () => {
  it('findings force defects_found even when the model says sound', async () => {
    const lying = JSON.stringify({
      verdict: 'sound',
      findings: [{ agent: 'an-engineer', severity: 'blocking', claim: 'c', checked: 'k', found: 'f' }],
    });
    const { res } = await review(lying, 'read_file');
    expect(
      res.verdict,
      'a reviewer listed a blocking defect and declared the roster sound — fail-open',
    ).toBe('defects_found');
  }, 60_000);

  it('no findings is a real answer', async () => {
    const { res } = await review(JSON.stringify({ verdict: 'sound', findings: [] }), 'read_file');
    expect(res.verdict).toBe('sound');
    expect(res.findings).toEqual([]);
    expect(res.reviewed).toBe(2);
  }, 60_000);

  it('a claimed "sound" with findings cannot hide them', async () => {
    const { res } = await review(FOUND, 'read_file');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe('blocking');
    expect(res.findings[0].checked).toMatch(/resolve_package_symbol/);
  }, 60_000);
});

describe('the reviewer sees the ticket and the documents the briefs came from', () => {
  it('the ticket arrives whole — components and links, not a summary', async () => {
    const { prompt } = await review(FOUND, 'read_file');
    expect(prompt, 'components say how far the work reaches').toContain('ALPHA, BETA');
    expect(prompt).toContain('somevendor.example/docs/preview');
  }, 60_000);

  it('the fetched documentation reaches it', async () => {
    const { prompt } = await review(FOUND, 'read_file');
    expect(
      prompt,
      'the reviewer cannot tell a doc-following mistake from an invention without the doc',
    ).toContain('pass preview_token in the Stack options');
  }, 60_000);

  it('it is told the documentation may be right about the product and wrong about these repos', async () => {
    const { prompt } = await review(FOUND, 'read_file');
    expect(prompt).toMatch(/wrong about these repositories/i);
    expect(prompt).toMatch(/version-correct instruction/i);
  }, 60_000);

  it('with no documents it is told so, and that such claims are unverifiable', async () => {
    const r = runner(FOUND);
    await spec.reviewRoster({
      promptExec: r, minted: MINTED, profiles: PROFILES,
      codelines: [], tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [], logDir: r.dir, repoPath: '', toolGrant: 'read_file',
    });
    const p = readFileSync(r.capture, 'utf8');
    expect(p).toMatch(/No documentation was fetched/);
    expect(p).toMatch(/unverifiable/i);
  }, 60_000);
});

describe('an empty roster is not reviewed', () => {
  it('nothing minted means nothing to falsify', async () => {
    const r = runner(FOUND);
    const res = await spec.reviewRoster({
      promptExec: r, minted: [], profiles: PROFILES, codelines: [], tickets: [],
      logDir: r.dir, repoPath: '', toolGrant: 'read_file',
    });
    expect(res.verdict).toBe('sound');
    expect(res.reviewed).toBe(0);
    expect(existsSync(r.capture), 'an agent was invoked with no roster to review').toBe(false);
  }, 60_000);
});
