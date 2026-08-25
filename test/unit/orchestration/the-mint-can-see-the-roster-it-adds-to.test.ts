/**
 * THE MINT CAN SEE THE ROSTER IT IS ADDING TO.
 *
 * agent-mint proposes project-specific roles and merges them into an existing roster. It was told
 * what already exists by FIXED_AGENT_ROLES — 21 hardcoded names in src/scaffold/prdTypes.ts —
 * while the canonical roster holds 57. So 39 canonical agents were invisible to the proposer.
 *
 * That is not academic. Live 2026-08-23, the roster reviewer raised a BLOCKING finding that the
 * implementer's brief "defers test ownership to a dedicated test agent, but no test agent was
 * minted in this roster" — while a canonical `test-engineer` existed the whole time and the mint
 * had never been shown it. A proposer that cannot see the roster either duplicates a role under a
 * different name, or reports a gap that is already filled.
 *
 * The list is READ FROM THE ROSTER at call time. A hardcoded list drifts from the real one the
 * moment either changes, which is the defect being replaced — so these assertions compare against
 * the roster on disk, never against names written here.
 *
 * DRIVEN THROUGH THE REAL INVOCATION. runClaude spawns execSpec.cmd and writes the prompt to its
 * stdin, so a stubbed `promptExec` function is never called and proves nothing. This uses a real
 * executable that records what it receives — the same shape the pipeline runs.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const CANONICAL = join(ROOT, 'orchestrations/agents/profiles.json');

/** The canonical roster on disk — the source of truth these assertions compare against. */
const canonicalNames = (): string[] => {
  const raw = JSON.parse(readFileSync(CANONICAL, 'utf8'));
  const m = raw.agents && typeof raw.agents === 'object' ? raw.agents : raw;
  return Object.keys(m).filter((k) => !k.startsWith('_') && !k.startsWith('$'));
};

/** A real executable that records every prompt it is given and answers with a valid proposal. */
const recorder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-stub-'));
  const capture = join(dir, 'prompts');
  const stub = join(dir, 'stub.sh');
  const reply = {
    proposedAgents: [{
      name: 'checkout-form-fixer', kind: 'implementer', codeline: '*',
      systemPrompt: 'You implement the checkout form fix.', rationale: 'Someone must edit source.',
    }],
  };
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '<<<P>>>' >> "${capture}"`,
    `cat >> "${capture}"`,
    "cat <<'JSONEOF'",
    JSON.stringify(reply),
    'JSONEOF',
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    promptExec: { cmd: stub, args: [] },
    prompts: () => (existsSync(capture)
      ? readFileSync(capture, 'utf8').split('<<<P>>>').filter((x) => x.trim()) : []),
  };
};

const mint = async (r: ReturnType<typeof recorder>, projectCfg?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-run-'));
  const profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, readFileSync(CANONICAL, 'utf8'));
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
  if (projectCfg) process.env.EPAM_PROJECT_CONFIG_DIR = projectCfg;
  else delete process.env.EPAM_PROJECT_CONFIG_DIR;
  try {
    await spec.mintProjectAgents({
      promptExec: r.promptExec,
      tickets: [{ jiraKey: 'X-1', title: 'a ticket', description: 'do a thing' }],
      referencedDocs: [], declaredDependencies: [], codelines: [{ name: 'cl', path: dir }],
      toolGrant: 'read-only', profilesPath, agentsDir: dir, logDir: dir, repoPath: dir,
    });
  } catch { /* the merge may reject; the PROMPT is what this asserts */ }
  finally {
    if (prev) process.env.EPAM_PROJECT_CONFIG_DIR = prev;
    else delete process.env.EPAM_PROJECT_CONFIG_DIR;
  }
  return r.prompts().join('\n');
};

describe('the proposer is shown the roster that already exists', () => {
  it('the canonical roster is bigger than the old hardcoded list — the premise', () => {
    expect(canonicalNames().length).toBeGreaterThan(21);
  });

  it('EVERY canonical agent name reaches the prompt', async () => {
    const r = recorder();
    const prompt = await mint(r);
    expect(r.prompts().length, 'the mint was never invoked').toBeGreaterThan(0);
    const missing = canonicalNames().filter((n) => !prompt.includes(n));
    expect(missing,
      `${missing.length} canonical agent(s) are invisible to the proposer: ${missing.slice(0, 6).join(', ')}`)
      .toEqual([]);
  });

  it('test-engineer specifically — the agent whose absence was reported as a blocking gap', async () => {
    const r = recorder();
    const prompt = await mint(r);
    const hasTestEngineer = canonicalNames().includes('test-engineer');
    expect(hasTestEngineer, 'test-engineer is no longer canonical; this case needs rewriting').toBe(true);
    expect(prompt, 'the mint still cannot see test-engineer').toContain('test-engineer');
  });

  it('tells it not to re-propose or overlap them', async () => {
    const r = recorder();
    const prompt = await mint(r);
    expect(prompt).toMatch(/do not propose a role whose remit overlaps/i);
    expect(prompt, 'nothing warns the proposer off reporting an already-filled gap')
      .toMatch(/false gap|already fills|need is MET/i);
  });

  it('includes roles THIS PROJECT already minted, not just canonical ones', async () => {
    // A re-run must not re-propose the crew the previous cycle minted under a new name.
    const cfg = mkdtempSync(join(tmpdir(), 'proj-cfg-'));
    writeFileSync(join(cfg, 'project-roles.json'),
      JSON.stringify({ roles: ['already-minted-implementer'] }));
    const r = recorder();
    const prompt = await mint(r, cfg);
    expect(prompt, "a role this project already minted was not shown to the proposer")
      .toContain('already-minted-implementer');
  });

  it('the block is absent, not blank, when there is no roster to show', async () => {
    // An empty section reads as "nothing exists", which is worse than saying nothing.
    const dir = mkdtempSync(join(tmpdir(), 'empty-roster-'));
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({}));
    const r = recorder();
    delete process.env.EPAM_PROJECT_CONFIG_DIR;
    try {
      await spec.mintProjectAgents({
        promptExec: r.promptExec, tickets: [{ jiraKey: 'X-1', title: 't', description: 'd' }],
        referencedDocs: [], declaredDependencies: [], codelines: [{ name: 'cl', path: dir }],
        toolGrant: 'read-only', profilesPath, agentsDir: dir, logDir: dir, repoPath: dir,
      });
    } catch { /* prompt is what matters */ }
    const prompt = r.prompts().join('\n');
    expect(prompt.length, 'no prompt was captured').toBeGreaterThan(100);
    expect(prompt, 'an empty roster rendered a header with nothing under it')
      .not.toMatch(/THESE AGENTS ALREADY EXIST[\s\S]{0,80}\n\n\n/);
  });
});
