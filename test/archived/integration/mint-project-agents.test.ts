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
    { name: 'some-domain-engineer', kind: 'implementer', codeline: '*', systemPrompt: 'You own a domain. '.repeat(20), rationale: 'This estate has a distinct domain that no canonical role covers.' },
    { name: 'another-domain-specialist', kind: 'implementer', codeline: '*', systemPrompt: 'You own another. '.repeat(20), rationale: 'A second domain here is owned by nothing in the canonical core.' },
  ],
});

/**
 * A runner answering DIFFERENTLY on each successive call, so a re-proposal can be exercised.
 * Each call appends its prompt to a capture file and emits the next answer in the list.
 */
function sequenceRunner(answers: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-seq-')); dirs.push(dir);
  const capture = join(dir, 'prompts.txt');
  const counter = join(dir, 'n');
  const sh = join(dir, 'run.sh');
  const cases = answers
    .map((a, i) => `  ${i}) cat <<'ANSWER'\n<PROJECT_AGENTS>${a}</PROJECT_AGENTS>\nANSWER\n  ;;`)
    .join('\n');
  writeFileSync(sh,
    `#!/usr/bin/env bash\n` +
    `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)\n` +
    `{ echo "===PROMPT $n==="; cat; } >> ${JSON.stringify(capture)}\n` +
    `echo $((n+1)) > ${JSON.stringify(counter)}\n` +
    `case "$n" in\n${cases}\n  *) echo '<PROJECT_AGENTS>{"proposedAgents":[]}</PROJECT_AGENTS>' ;;\nesac\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], capture, counter };
}

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
    // KB-1: stores are per CODELINE, not per role — a role-keyed file is never read.
    expect(existsSync(join(ws.dir, 'KB-shared.md'))).toBe(true);
    expect(res.minted.map((m: any) => m.name)).toContain('some-domain-engineer');
  }, 60_000);

  it('a proposal colliding with the canonical core cannot overwrite it', async () => {
    const canonical = FIXED_AGENT_ROLES[0];
    const answer = JSON.stringify({
      proposedAgents: [{ name: canonical, kind: 'implementer', codeline: '*', systemPrompt: 'LLM SUGGESTION '.repeat(10), rationale: 'A collision with a canonical role, deliberately proposed.' }],
    });
    const { profiles, res } = await mint({ answer });
    expect(profiles[canonical]).toBe('CANONICAL BRIEF');
    expect(res.rejected.map((r: any) => r.name)).toContain(canonical);
  }, 60_000);
});

describe('a corrective pass is told what it is replacing AND what it is keeping', () => {
  it('the findings reach the proposer as evidence, not as a bare verdict', async () => {
    const { prompt } = await mint({
      correctiveFindings: [{
        agent: 'some-domain-engineer',
        claim: 'the codeline uses a monorepo layout',
        checked: 'listed the repository root',
        found: 'a single package.json and no workspaces field',
        remedy: 'do not describe the layout the brief cannot verify',
      }],
    });
    expect(prompt).toContain('some-domain-engineer');
    expect(prompt, 'the correction got a verdict with no evidence and will reword the same defect')
      .toContain('a single package.json and no workspaces field');
    expect(prompt).toContain('do not describe the layout the brief cannot verify');
  }, 60_000);

  it('the retained roles are named so the correction does not re-propose them', async () => {
    // ARCH-7: a targeted correction replaces only the indicted briefs. A proposer not told
    // which roles survived re-proposes the same coverage under a new name — mergeProjectAgents
    // refuses the duplicate, but the proposal budget is spent and the real gap goes uncovered.
    const { prompt } = await mint({
      correctiveFindings: [{ agent: 'gone-engineer', claim: 'c', checked: 'k', found: 'f' }],
      retainedAgents: [
        { name: 'kept-engineer', codeline: '*', rationale: 'owns a domain nothing else covers' },
        { name: 'kept-investigator', codeline: 'alpha', rationale: 'reads codeline alpha' },
      ],
    });
    expect(prompt).toContain('kept-engineer');
    expect(prompt).toContain('owns a domain nothing else covers');
    expect(prompt, 'a retained investigator lost the codeline that makes it findable').toContain('alpha');
    expect(prompt).toMatch(/ALREADY EXIST[^]{0,200}KEPT/);
  }, 60_000);

  it('a first (non-corrective) mint carries neither block — nothing to correct or keep', async () => {
    const { prompt } = await mint();
    expect(prompt).not.toMatch(/ALREADY EXIST/);
    expect(prompt).not.toMatch(/REVIEWED AND REJECTED/);
  }, 60_000);
});

describe('a refused proposal is retried, not left as an empty roster', () => {
  const lazy = JSON.stringify({
    proposedAgents: [
      { name: 'lazy-engineer', kind: 'implementer', codeline: '*',
        systemPrompt: 'You own a domain. '.repeat(20), rationale: '...' },
    ],
  });
  const corrected = JSON.stringify({
    proposedAgents: [
      { name: 'lazy-engineer', kind: 'implementer', codeline: '*',
        systemPrompt: 'You own a domain. '.repeat(20),
        rationale: 'The estate has a scheduling domain that no canonical role covers.' },
    ],
  });

  async function run(answers: string[]) {
    const ws = workspace();
    const runner = sequenceRunner(answers);
    delete process.env.SPEC_MODE_PROVIDER;
    const res = await spec.mintProjectAgents({
      promptExec: runner, tickets: TICKETS, referencedDocs: DOCS,
      profilesPath: ws.profilesPath, agentsDir: ws.dir, logDir: ws.dir, repoPath: ws.dir,
    });
    return { res, ws, prompts: readFileSync(runner.capture, 'utf8') };
  }

  it('a rationale of "..." is refused and the corrected re-proposal is minted', async () => {
    // The live 2026-08-07 shape: the schema was satisfied, the field said nothing.
    const { res } = await run([lazy, corrected]);
    expect(res.attempts).toBe(2);
    expect(res.minted.map((m: any) => m.name)).toContain('lazy-engineer');
  }, 60_000);

  it('the retry is told which proposal was refused and why', async () => {
    const { prompts } = await run([lazy, corrected]);
    const second = prompts.slice(prompts.indexOf('===PROMPT 1==='));
    expect(second, 'the retry got no account of the refusal and will repeat it').toContain('lazy-engineer');
    expect(second).toMatch(/rationale/i);
    expect(second).toMatch(/PARTLY REFUSED/);
  }, 60_000);

  it('a first attempt with nothing refused does not retry — no wasted call', async () => {
    const { res } = await run([ANSWER]);
    expect(res.attempts).toBe(1);
  }, 60_000);

  it('retries are bounded — a model that never complies does not loop', async () => {
    const { res } = await run([lazy, lazy, lazy, lazy]);
    expect(res.attempts).toBe(2);
    expect(res.minted).toEqual([]);
  }, 60_000);
});

describe('what was proposed is persisted, not just counted', () => {
  it('the full proposals are written to disk, system prompts included', async () => {
    // profiles.json is ephemeral and restored from canonical each run, so the briefs survive
    // nowhere else; a refused proposal previously left no trace of what it had said.
    const { ws } = await mint();
    const file = join(ws.dir, 'agent-mint-proposals.json');
    expect(existsSync(file), 'only a count of the proposals was recorded').toBe(true);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    expect(rec.proposals.map((p: any) => p.name)).toContain('some-domain-engineer');
    expect(rec.proposals[0].systemPrompt.length).toBeGreaterThan(50);
  }, 60_000);

  it('a REFUSED proposal is persisted with the reason it was refused', async () => {
    const answer = JSON.stringify({
      proposedAgents: [{ name: 'refused-engineer', kind: 'implementer', codeline: '*',
        systemPrompt: 'x'.repeat(60), rationale: '...' }],
    });
    const { ws } = await mint({ answer });
    const rec = JSON.parse(readFileSync(join(ws.dir, 'agent-mint-proposals.json'), 'utf8'));
    expect(rec.proposals[0].name).toBe('refused-engineer');
    expect(rec.refused.length).toBe(1);
    expect(rec.refused[0].reason).toMatch(/rationale/i);
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
