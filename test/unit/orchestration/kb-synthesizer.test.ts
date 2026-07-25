/**
 * SYNTHESIS — episodes become a constraint, and the model is bounded by the schema.
 *
 * This is the one place an LLM re-enters the self-heal loop. It is safe to let it
 * back in only because its output space IS the enforcement space: the prompt
 * carries the JSON Schema generated from kb_schema.py, and anything that fails
 * Pydantic validation is rejected outright. The model cannot propose a fix with no
 * mechanism — which is exactly what the old analyst does when it answers
 * `target=none` on 77 of 118 diagnoses because none of its options patch anything.
 *
 * A single failure is not knowledge. Synthesis triggers only on a REPEAT, because
 * a transient error promoted to a permanent rule is the drift the whole design
 * exists to prevent.
 *
 * Rejection must leave the store untouched — no half-written rule, no
 * `[unreviewed-fallback]` persistence of the kind run_failure_analyst does today
 * after three reviewer rejections.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

let store: any, synth: any, dir: string, promptFile: string;

/** Stub agent: echoes a canned reply, and records the prompt it was given. */
function stubRunner(reply: string): string {
  const p = join(dir, 'stub-runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat > ${JSON.stringify(promptFile)}\ncat <<'REPLY'\n${reply}\nREPLY\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-synth-')); dirs.push(dir);
  promptFile = join(dir, 'prompt.txt');
  store = require(join(LIB, 'kb-store.js'));
  synth = require(join(LIB, 'kb-synthesizer.js'));
  store.configure({ root: dir });
});

const record = (n: number, sig = 'TS2532') => {
  for (let i = 0; i < n; i++)
    store.recordEpisode({ id: `e${i}`, story_id: `S-${i}`, agent_role: 'typescript-engineer',
      signature: sig, signature_source: 'tsc', diagnosis: `optional accessed without narrowing #${i}` });
};

const VALID = JSON.stringify({
  enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '14' },
  reason: 'repeated strict-null failure needs more iterations',
});

describe('trigger — a repeat, never a one-off', () => {
  it('does NOT synthesise from a single episode', async () => {
    record(1);
    const out = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner(VALID) });
    expect(out).toBeNull();
    expect(store.readConstraints()).toHaveLength(0);
  });

  it('synthesises once the signature repeats', async () => {
    record(2);
    const out = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner(VALID) });
    expect(out).not.toBeNull();
    expect(store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' })).toHaveLength(1);
  });

  it('the threshold is configurable', async () => {
    record(2);
    const out = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', threshold: 5, runner: stubRunner(VALID) });
    expect(out).toBeNull();
  });
});

describe('the model is bounded by the generated schema', () => {
  it('the prompt carries the JSON Schema, so output space = enforcement space', async () => {
    record(2);
    await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner(VALID) });
    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toMatch(/"kind"/);
    for (const kind of ['gate', 'param', 'tool_scope']) expect(prompt).toContain(kind);
  });

  it('the prompt shows the real evidence it must explain', async () => {
    record(2);
    await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner(VALID) });
    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('TS2532');
    expect(prompt).toMatch(/optional accessed without narrowing/);
  });
});

describe('rejection leaves the store untouched', () => {
  it('rejects a prose-only "constraint"', async () => {
    record(2);
    const out = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532',
      runner: stubRunner(JSON.stringify({ enforcement: { kind: 'note', text: 'be careful' }, reason: 'r' })) });
    expect(out).toBeNull();
    expect(store.readConstraints()).toHaveLength(0);
  });

  it('rejects unparseable output rather than guessing', async () => {
    record(2);
    const out = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532',
      runner: stubRunner('I think you should probably increase the iterations a bit') });
    expect(out).toBeNull();
    expect(store.readConstraints()).toHaveLength(0);
  });

  it('rejects an empty reply', async () => {
    record(2);
    const out = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner('') });
    expect(out).toBeNull();
    expect(store.readConstraints()).toHaveLength(0);
  });
});

describe('an existing rule is not re-derived every time', () => {
  it('returns the stored rule instead of re-asking the model', async () => {
    record(2);
    await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner(VALID) });
    rmSync(promptFile, { force: true });
    const again = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner('SHOULD NOT BE CALLED') });
    expect(again.enforcement.value).toBe('14');
    expect(existsSync(promptFile)).toBe(false);   // the model was never consulted
  });
});

describe('how a stale rule is REPLACED — the pillar 2 update path', () => {
  it('TTL expiry archives it, and the next synthesis derives a fresh one', async () => {
    const arb = require(join(LIB, 'kb-arbitration.js'));
    record(2);
    await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532', runner: stubRunner(VALID) });

    // The system moves on and the rule stops firing. It must not be trusted forever.
    const c = store.readConstraints()[0];
    store.putConstraint({ ...c, ttl_cycles: 2 });
    arb.tick(store, { fired: [] });
    arb.tick(store, { fired: [] });
    expect(store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' })).toHaveLength(0);

    // With no active rule, synthesis runs again and the new value takes effect.
    const fresh = await synth.maybeSynthesize(store, {
      agent_role: 'typescript-engineer', signature: 'TS2532',
      runner: stubRunner(JSON.stringify({
        enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '20' }, reason: 'more' })) });
    expect(fresh.enforcement.value).toBe('20');
    const active = store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' });
    expect(active).toHaveLength(1);
    expect(active[0].enforcement.value).toBe('20');
  });
});
