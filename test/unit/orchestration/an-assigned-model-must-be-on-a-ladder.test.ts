/**
 * AN ASSIGNED MODEL MUST BE ON A LADDER.
 *
 * Live, run 20260814T224748Z (metrolinx, AMSD-2041):
 *
 *     [InferenceLadder] AMSD-2041 resuming on 'MiniMax-M3'
 *                       (escalated in an earlier invocation; PRD model is 'gpt-5-codex')
 *
 * `gpt-5-codex` is on NO ladder. Every rung of every tier this project declares is a
 * MiniMax / z-ai / zhipuai / moonshotai model; the string appears nowhere except
 * config/model-pricing.json. The prd-model-coordinator assigned it, and nothing
 * checked.
 *
 * Why that is not cosmetic: the ladder successor lookup returns EMPTY for a model that
 * is not on the chain, which is indistinguishable from "already at the top rung". So a
 * story started on an unladdered model burns every attempt on one model and never
 * escalates, and the log reads exactly like a story that legitimately hit the ceiling.
 * The B31 invariant in this repo already documents that failure mode; this closes the
 * door that lets such a model be assigned in the first place.
 *
 * The run only escaped because ladder position had persisted from an earlier run, so it
 * resumed mid-chain and climbed from there — the PRD's own assignment was ignored.
 *
 * NOTHING IS HARDCODED. The rungs come from the project's llm-settings.json; no model
 * name appears in the gate or in this test's assertions about the real project.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// LADDERS AND MODEL OVERRIDES MOVED TO THE STACK. The 2026-08-25 migration took them out of each
// project's llm-settings.json and into config/llm-defaults.<set>.json — a ladder names MODELS and
// a model belongs to a STACK. This file read the project copy, which now carries only a note
// saying so, so every lookup came back empty. See test/support/llm-settings.ts.
import { stackSettings, defaultStack } from '../../support/llm-settings'
const REPO_ROOT_CFG = join(__dirname, '../../../orchestrations/config');

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/model-ladder-membership.sh');
const SETTINGS = join(REPO_ROOT_CFG, `llm-defaults.${defaultStack()}.json`);

/** Every model that is a rung of any tier the project declares. */
function declaredRungs(): string[] {
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  const out = new Set<string>();
  for (const tier of Object.values<any>(s.ladders ?? {})) {
    for (const hop of tier.modelLadder ?? []) { out.add(hop.from); out.add(hop.to); }
    if (tier.startModel) out.add(tier.startModel);
  }
  return [...out];
}

function run(fn: string, ...args: string[]) {
  const res = spawnSync('bash', ['-c', `. "${LIB}"; ${fn} ${args.map((a) => JSON.stringify(a)).join(' ')}`], {
    encoding: 'utf8',
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

/** A PRD assigning `model` to one story. */
function prdWith(model: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-model-'));
  const p = join(dir, 'prd.json');
  const story: Record<string, unknown> = { id: 'AMSD-2041', title: 't' };
  if (model !== null) story.model = model;
  writeFileSync(p, JSON.stringify({ stories: [story], implementationOrder: { core: ['AMSD-2041'] } }));
  return p;
}

describe('model_is_on_ladder', () => {
  it('accepts every model the project actually declares as a rung', () => {
    const rungs = declaredRungs();
    expect(rungs.length, 'the project declares no rungs — this test would prove nothing').toBeGreaterThan(1);
    for (const m of rungs) {
      const r = run('model_is_on_ladder', m, SETTINGS);
      expect(r.status, `${m} is a declared rung but was rejected:\n${r.out}`).toBe(0);
    }
  });

  it('rejects the model the live run assigned', () => {
    // The one string that caused this: assigned by the coordinator, on no ladder.
    const r = run('model_is_on_ladder', 'gpt-5-codex', SETTINGS);
    expect(r.status).not.toBe(0);
  });

  it('rejects an empty or absent model rather than treating it as fine', () => {
    expect(run('model_is_on_ladder', '', SETTINGS).status).not.toBe(0);
  });

  it('reports UNKNOWN, never a pass, when the settings file is missing', () => {
    // A project whose ladders cannot be read must not silently approve every model.
    const r = run('model_is_on_ladder', 'anything', '/nonexistent/llm-settings.json');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/cannot|unknown|no ladder/i);
  });
});

describe('stories_with_unladdered_models', () => {
  it('names the story and the model when an assignment is off-ladder', () => {
    const r = run('stories_with_unladdered_models', prdWith('gpt-5-codex'), SETTINGS);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('AMSD-2041');
    expect(r.out).toContain('gpt-5-codex');
  });

  it('passes when the assignment is a declared rung', () => {
    const r = run('stories_with_unladdered_models', prdWith(declaredRungs()[0]), SETTINGS);
    expect(r.status, r.out).toBe(0);
  });

  it('passes when no model is assigned — that is the coordinator\'s job, not a violation', () => {
    const r = run('stories_with_unladdered_models', prdWith(null), SETTINGS);
    expect(r.status, r.out).toBe(0);
  });
});

/**
 * The preflight refuses a bad assignment before a run spends anything — but the
 * coordinator runs DURING a run, at Step 7, long after preflight. That is exactly how
 * `gpt-5-codex` got in. So the reviewer that approves the coordinator's write has to
 * check membership too, and this executes the REAL reviewer, extracted from the
 * orchestrator, rather than a copy of its logic.
 */
describe('the model coordinator reviewer rejects an off-ladder assignment', () => {
  const MC_REVIEW = join(ROOT, 'orchestrations/scripts/lib/handlers/mc-review.py');

  function reviewerVerdict(assigned: string | null) {
    // THE HEREDOC IS A HANDLER NOW. The reviewer was an MC_REVIEW_PY heredoc inside the
    // orchestrator; it moved to lib/handlers/mc-review.py with the same argv contract
    // (before, after, settings). Lifting the heredoc reported the reviewer as MISSING rather
    // than as relocated — and a reviewer reported missing is a gate reported unwired.

    const dir = mkdtempSync(join(tmpdir(), 'mc-review-'));
    try {
      const story: Record<string, unknown> = { id: 'AMSD-2041', title: 't' };
      const before = join(dir, 'before.json');
      const after = join(dir, 'after.json');
      writeFileSync(before, JSON.stringify({ stories: [story], implementationOrder: { core: ['AMSD-2041'] } }));
      const afterStory = { ...story, ...(assigned === null ? {} : { model: assigned }) };
      writeFileSync(after, JSON.stringify({ stories: [afterStory], implementationOrder: { core: ['AMSD-2041'] } }));
      const res = spawnSync('python3', [MC_REVIEW, before, after, SETTINGS], { encoding: 'utf8' });
      return { verdict: (res.stdout || '').trim(), err: res.stderr || '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes a model that is a declared rung', () => {
    const r = reviewerVerdict(declaredRungs()[0]);
    expect(r.verdict, r.err).toBe('pass');
  });

  it('FAILS the assignment the live run made, and names an alternative', () => {
    const r = reviewerVerdict('gpt-5-codex');
    expect(r.verdict).toBe('fail');
    expect(r.err).toMatch(/gpt-5-codex/);
    expect(r.err, 'the corrective note must tell the retry what it CAN choose').toMatch(/choose one of/);
  });

  it('still passes when the coordinator assigned nothing', () => {
    const r = reviewerVerdict(null);
    expect(r.verdict, r.err).toBe('pass');
  });

  it('refuses to approve when the ladder declaration cannot be read', () => {
    // UNKNOWN is not "fine": a missing settings file must not silently bless any model.
    const dir = mkdtempSync(join(tmpdir(), 'mc-review-none-'));
    try {
      const before = join(dir, 'b.json'); const after = join(dir, 'a.json');
      writeFileSync(before, JSON.stringify({ stories: [{ id: 'S1' }] }));
      writeFileSync(after, JSON.stringify({ stories: [{ id: 'S1', model: 'anything' }] }));
      const res = spawnSync('python3', [MC_REVIEW, before, after, '/nonexistent/llm-settings.json'], { encoding: 'utf8' });
      expect((res.stdout || '').trim()).toBe('fail');
      expect(res.stderr).toMatch(/cannot read ladder declarations/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the gate holds no model vocabulary of its own', () => {
  it('names no model, tier or provider', () => {
    const code = readFileSync(LIB, 'utf8').replace(/^\s*#.*$/gm, '');
    for (const literal of ['MiniMax', 'glm', 'kimi', 'gpt-', 'zhipuai', 'moonshotai', 'z-ai']) {
      expect(code, `the gate hardcodes '${literal}'`).not.toContain(literal);
    }
  });
});
