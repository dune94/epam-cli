/**
 * A ROLE THAT CANNOT EDIT FILES CANNOT DELIVER A STORY.
 *
 * Live 2026-08-07. Three roles were minted and AMSD-2041 went to
 * `contentstack-preview-config-specialist`, whose brief owns "the Contentstack dashboard"
 * and "documentation or config files" — the only one of the three owning no source files.
 * This pipeline's agents produce changes in a repository, so the most that role can deliver
 * is a configuration note: the exact shape of an earlier failure where a config-only change
 * was approved and the feature did not work.
 *
 * The assignment prompt said "pick the role whose expertise covers the work" and nothing
 * about being able to write it.
 *
 * And nobody owned tests. The proposal prompt's only mention of "test" was inside the list of
 * canonical roles it must NOT duplicate. For a novel brownfield story that is the deadlock
 * from two earlier runs: the TC writer runs, and no minted role knows where this codeline's
 * tests live, what they are named, or which runner executes them.
 *
 * Asserted on the rendered prompts — the artefacts the model actually receives.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

/** Render the real mint prompt by capturing what the seam builds. */
async function mintPrompt(): Promise<string> {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'own-'));
  const capture = join(dir, 'p.txt');
  const sh = join(dir, 'r.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\ncat <<'A'\n<PROJECT_AGENTS>{"proposedAgents":[{"name":"a-engineer","systemPrompt":"xxxxxxxxxxxxxxxxxxxx","rationale":"r"}]}</PROJECT_AGENTS>\nA\n`);
  chmodSync(sh, 0o755);
  writeFileSync(join(dir, 'profiles.json'), '{}');
  delete process.env.SPEC_MODE_PROVIDER;
  await spec.mintProjectAgents({
    promptExec: { cmd: sh, args: [] },
    tickets: [{ id: 'T-1', title: 't', description: 'd' }],
    referencedDocs: [], declaredDependencies: [],
    profilesPath: join(dir, 'profiles.json'), agentsDir: dir, logDir: dir, repoPath: '',
  });
  return readFileSync(capture, 'utf8');
}

/** Render the real assignment prompt. */
async function assignPrompt(): Promise<string> {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'own2-'));
  const capture = join(dir, 'p.txt');
  const sh = join(dir, 'r.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\ncat <<'A'\n<ROLE_ASSIGNMENTS>{"assignments":[{"storyId":"T-1","agentRole":"a-engineer","reason":"r"}]}</ROLE_ASSIGNMENTS>\nA\n`);
  chmodSync(sh, 0o755);
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ 'a-engineer': 'owns src/' }));
  writeFileSync(join(dir, 'project-roles.json'), JSON.stringify({ roles: ['a-engineer'] }));
  await spec.assignAgentRoles({
    promptExec: { cmd: sh, args: [] },
    stories: [{ id: 'T-1', title: 't', description: 'd' }],
    profilesPath: join(dir, 'profiles.json'), logDir: dir, repoPath: '',
  });
  return readFileSync(capture, 'utf8');
}

describe('the mint requires every role to author code', () => {
  it('the prompt demands each brief name the files it edits', async () => {
    const p = await mintPrompt();
    expect(p, 'a role can be proposed that owns no files and cannot implement anything')
      .toMatch(/MUST BE ABLE TO AUTHOR CODE/i);
    expect(p).toMatch(/name the files or directories/i);
  }, 60_000);

  it('it rules out console-only and prose-only roles', async () => {
    const p = await mintPrompt();
    expect(p).toMatch(/console/i);
    expect(p).toMatch(/never as a role of its own/i);
  }, 60_000);
});

describe('the mint requires test responsibility to be owned', () => {
  it('the prompt demands an explicit test owner', async () => {
    const p = await mintPrompt();
    expect(p, 'no role is told to own tests — the deadlock from two earlier runs')
      .toMatch(/TEST RESPONSIBILITY MUST BE OWNED/i);
  }, 60_000);

  it('it asks for where tests live, how they are named, and the runner', async () => {
    const p = await mintPrompt();
    expect(p).toMatch(/where test files live/i);
    expect(p).toMatch(/how they are named/i);
    expect(p).toMatch(/runner/i);
  }, 60_000);

  it('it grounds that in what the codelines declare, not habit', async () => {
    const p = await mintPrompt();
    expect(p).toMatch(/not from habit/i);
  }, 60_000);
});

describe('assignment picks the role that edits the files', () => {
  it('THE LIVE DEFECT: the owner must author the code', async () => {
    const p = await assignPrompt();
    expect(p, 'the story can be assigned to a role that owns no source files')
      .toMatch(/OWNER MUST AUTHOR THE CODE/i);
    expect(p).toMatch(/EDIT THE FILES/i);
  }, 60_000);

  it('when a story needs console work AND code, the code owner is the assignee', async () => {
    const p = await assignPrompt();
    expect(p).toMatch(/the code owner is the assignee/i);
  }, 60_000);

  it('the original selection guidance survives', async () => {
    const p = await assignPrompt();
    expect(p).toMatch(/exactly one role/i);
    expect(p).toMatch(/AVAILABLE ROLES/);
  }, 60_000);
});
