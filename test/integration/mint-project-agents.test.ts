/**
 * THE MINT MUST BE A FIRST-CLASS AGENT CALL, AND IT MUST SEE THE TICKET.
 *
 * proposeAgents() in the SDK calls an LLMProvider directly. Driving the brownfield mint
 * through it would put the one call that decides the entire roster OUTSIDE the invocation
 * gateway: no ladder, no retry, no self-heal, no timeout profile, no cost capture. The one
 * agent whose failure silently degrades every later agent would be the one agent with no
 * resilience. So the mint reuses the SDK's PROMPT and runs it through runAgentForJson,
 * exactly as deriveGuardVocabulary does.
 *
 * And it must be briefed on the real project. A proposer that sees only a repo path will
 * proposed generic roles indistinguishable from the canonical core. The inputs that make
 * the roles project-specific are the ticket text and the documents linked on it — the same
 * documents that, on 2026-08-06, refuted a story's central assumption. Ordering was chosen
 * for exactly this reason: mint runs after ingest so the tickets and fetched docs exist.
 *
 * These tests execute the real seam against a stub runner and assert on the artifacts it
 * produces: the prompt actually delivered to the agent, and the roster actually written.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');
const { FIXED_AGENT_ROLES } = require('../../dist/sdk.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ANSWER = JSON.stringify({
  proposedAgents: [
    { name: 'some-domain-engineer', systemPrompt: 'You own a domain. '.repeat(20), rationale: 'the codeline has it' },
    { name: 'another-domain-specialist', systemPrompt: 'You own another. '.repeat(20), rationale: 'and this one' },
  ],
});

/** A runner that CAPTURES the prompt it is given, then answers. */
function capturingRunner(answer = ANSWER) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-runner-')); dirs.push(dir);
  const capture = join(dir, 'prompt.txt');
  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\n` +
    `cat > ${JSON.stringify(capture)}\n` +
    `cat <<'ANSWER'\n<PROJECT_AGENTS>${answer}</PROJECT_AGENTS>\nANSWER\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], capture };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mint-ws-')); dirs.push(dir);
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({ [FIXED_AGENT_ROLES[0]]: 'CANONICAL BRIEF' }, null, 2));
  return { dir, profilesPath };
}

const TICKETS = [{
  id: 'AMSD-2041', jiraKey: 'AMSD-2041',
  title: 'Enable draft preview for editors',
  description: 'Editors cannot see unpublished entries before they go live.',
  components: ['Web'],
}];

const DOCS = [{
  url: 'https://vendor.example/docs/preview',
  fetchStatus: 'fetched',
  quotes: ['the options object accepts a live_preview key', 'a management token is required'],
}];

async function mint(extra: Record<string, unknown> = {}) {
  const ws = workspace();
  const runner = capturingRunner((extra.answer as string) ?? ANSWER);
  delete process.env.SPEC_MODE_PROVIDER;
  const res = await spec.mintProjectAgents({
    promptExec: runner,
    tickets: TICKETS,
    referencedDocs: DOCS,
    profilesPath: ws.profilesPath,
    agentsDir: ws.dir,
    logDir: ws.dir,
    repoPath: ws.dir,
    ...extra,
  });
  const prompt = existsSync(runner.capture) ? readFileSync(runner.capture, 'utf8') : '';
  const profiles = JSON.parse(readFileSync(ws.profilesPath, 'utf8'));
  return { res, prompt, profiles, ws };
}

describe('the fixture is real', () => {
  it('the seam exists and produced a non-empty prompt and a result', async () => {
    const { res, prompt } = await mint();
    expect(typeof spec.mintProjectAgents).toBe('function');
    expect(prompt.length, 'no prompt reached the agent — every assertion below is vacuous').toBeGreaterThan(200);
    expect(res).toBeTruthy();
  }, 60_000);
});

describe('the proposer is briefed on THIS project', () => {
  it('the ticket reaches the agent', async () => {
    const { prompt } = await mint();
    expect(prompt).toContain('AMSD-2041');
    expect(prompt, 'the ticket title never reached the proposer').toContain('draft preview');
    expect(prompt, 'the description — the only substantive field a brownfield ticket has').toContain('unpublished entries');
  }, 60_000);

  it('the documents linked on the ticket reach the agent', async () => {
    const { prompt } = await mint();
    expect(
      prompt,
      'docs are what make a proposed role project-specific rather than generic',
    ).toContain('live_preview');
    expect(prompt).toContain('vendor.example');
  }, 60_000);

  it('the protected canonical core is named so the agent does not re-propose it', async () => {
    const { prompt } = await mint();
    expect(prompt).toContain(FIXED_AGENT_ROLES[0]);
  }, 60_000);
});

describe('the roster it writes obeys the merge rules', () => {
  it('proposed roles are minted and wired', async () => {
    const { res, profiles, ws } = await mint();
    expect(profiles['some-domain-engineer']).toBeTruthy();
    expect(profiles['another-domain-specialist']).toBeTruthy();
    expect(existsSync(join(ws.dir, 'KB-some-domain-engineer.md'))).toBe(true);
    expect(res.minted.map((m: any) => m.name)).toContain('some-domain-engineer');
  }, 60_000);

  it('a proposal colliding with the canonical core cannot overwrite it', async () => {
    const canonical = FIXED_AGENT_ROLES[0];
    const answer = JSON.stringify({
      proposedAgents: [{ name: canonical, systemPrompt: 'LLM SUGGESTION '.repeat(10), rationale: 'r' }],
    });
    const { profiles, res } = await mint({ answer });
    expect(profiles[canonical]).toBe('CANONICAL BRIEF');
    expect(res.rejected.map((r: any) => r.name)).toContain(canonical);
  }, 60_000);
});

describe('failure is honest — a mint that produced nothing says so', () => {
  it('an unusable answer does not silently write an empty roster', async () => {
    const { res, profiles } = await mint({ answer: JSON.stringify({ proposedAgents: [] }) });
    expect(res.minted.length).toBe(0);
    expect(
      Object.keys(profiles),
      'the existing roster was damaged by a mint that proposed nothing',
    ).toContain(FIXED_AGENT_ROLES[0]);
  }, 60_000);
});
