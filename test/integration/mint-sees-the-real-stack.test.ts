/**
 * THE MINT MUST BE GIVEN EVIDENCE, OR IT WILL INVENT SOME.
 *
 * Live 2026-08-07, first real mint. It proposed three roles, all briefed on a CMS vendor the
 * codeline does not use. Nothing malfunctioned; it had nothing to go on:
 *
 *   - the tickets said only "CMS" — neither product is named anywhere in them
 *   - `documents: 0 fetched of 2 link(s)` — both vendor documents failed to fetch
 *   - the repo path handed over was the ESTATE ROOT (33 repositories), not a repository,
 *     so "read the codeline before you answer" pointed where the answer is not
 *
 * Meanwhile the codeline's own package.json names the real vendor in its dependencies. That
 * is ground truth about a stack and it cannot be guessed at: a manifest either contains the
 * name or it does not.
 *
 * A path that is not a repository is worse than no path — it reads as evidence and contains
 * none.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** An estate root holding repos — the shape that was mistakenly passed as "the codeline". */
function estate() {
  const root = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(root);
  const repo = join(root, 'the-actual-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    dependencies: { '@somevendor/management': '1.0.0', 'some-framework': '2.0.0' },
    devDependencies: { 'a-test-runner': '3.0.0' },
  }));
  mkdirSync(join(root, 'another-repo', '.git'), { recursive: true });
  return { root, repo };
}

function capturingRunner(answer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-stack-')); dirs.push(dir);
  const capture = join(dir, 'prompt.txt');
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\ncat <<'A'\n<PROJECT_AGENTS>${answer}</PROJECT_AGENTS>\nA\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], capture, dir };
}

const ANSWER = JSON.stringify({
  proposedAgents: [{ name: 'a-domain-engineer', systemPrompt: 'x'.repeat(200), rationale: 'r' }],
});

describe('the declared stack reaches the proposer', () => {
  it('THE FIX: dependency names from the codeline manifest appear in the prompt', async () => {
    const { repo } = estate();
    const ws = mkdtempSync(join(tmpdir(), 'mint-ws-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);

    delete process.env.SPEC_MODE_PROVIDER;
    await spec.mintProjectAgents({
      promptExec: r,
      tickets: [{ id: 'T-1', title: 'preview drafts in CMS', description: 'generic, names no vendor' }],
      referencedDocs: [],
      declaredDependencies: ['@somevendor/management', 'some-framework', 'a-test-runner'],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: repo,
    });

    const prompt = readFileSync(r.capture, 'utf8');
    expect(
      prompt,
      'the mint had no evidence of which product is in use and invented one',
    ).toContain('@somevendor/management');
    expect(prompt).toContain('some-framework');
  }, 60_000);

  it('the prompt tells it NOT to propose around a product that is not declared', async () => {
    const { repo } = estate();
    const ws = mkdtempSync(join(tmpdir(), 'mint-ws2-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      declaredDependencies: ['@somevendor/management'],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: repo,
    });
    expect(readFileSync(r.capture, 'utf8')).toMatch(/does not appear here|not.*declare/i);
  }, 60_000);

  it('with no dependencies the block is absent — it never invites inference from nothing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-ws3-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    expect(readFileSync(r.capture, 'utf8')).not.toMatch(/DECLARES IT DEPENDS ON/);
  }, 60_000);
});

describe('the step resolves a REPOSITORY, not the estate root', () => {
  const step = require('../../orchestrations/scripts/mint-agents-step.js');
  const helpers = (arg: string) => ({
    declaredDependencies: step.declaredDependencies,
    resolveRepoPath: (prd: any, stories: any[]) => step.resolveRepoPath(prd, stories, arg),
  });

  it('a manifest is read into a dependency list', () => {
    const { repo } = estate();
    const deps = helpers('').declaredDependencies(repo);
    expect(deps).toContain('@somevendor/management');
    expect(deps).toContain('a-test-runner');
  });

  it('an estate root yields no dependencies — it is not a repository', () => {
    const { root } = estate();
    expect(
      helpers('').declaredDependencies(root),
      'the estate root read as if it were the codeline',
    ).toEqual([]);
  });

  it('the PRD outputDir is used when the passed path is not a repository', () => {
    const { root, repo } = estate();
    const resolved = helpers(root).resolveRepoPath({ project: { outputDir: repo } }, []);
    expect(
      resolved,
      'the estate root was accepted as the codeline — this is the live defect',
    ).toBe(repo);
  });

  it('a real repository passed explicitly is honoured', () => {
    const { repo } = estate();
    expect(helpers(repo).resolveRepoPath({}, [])).toBe(repo);
  });

  it('nothing resolvable yields empty, not a wrong path', () => {
    expect(helpers('/nonexistent/estate').resolveRepoPath({}, [])).toBe('');
  });
});

describe('a ticket link reaches the proposer even when the fetch failed', () => {
  it('THE LIVE DEFECT: the URL is evidence, and it was dropped when unfetchable', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-links-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r,
      tickets: [{
        id: 'T-1', title: 'preview drafts in CMS', description: 'names no vendor at all',
        ticketLinks: [{ url: 'https://www.somevendor.com/docs/live-preview' }],
      }],
      // Fetch produced nothing — exactly the live case.
      referencedDocs: [],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    expect(
      readFileSync(r.capture, 'utf8'),
      'both linked documents failed to fetch and their URLs — which named the vendor — were discarded',
    ).toContain('somevendor.com');
  }, 60_000);
});
