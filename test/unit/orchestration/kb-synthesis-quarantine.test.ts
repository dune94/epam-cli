/**
 * PILLAR 4 — synthesizer blast radius: no rule may be dropped silently.
 *
 * kb-synthesizer.js is the one place an LLM re-enters the self-heal loop. Its
 * output space is bounded by kb_schema.py's discriminated union (gate | param |
 * tool_scope), so an unenforceable "constraint" is unconstructable rather than
 * merely rejected. That part works. What did not exist is any record of a
 * proposal that failed to make it in — there were four separate `return null`
 * paths, none of which left evidence:
 *
 *   1. empty reply        — the runner FAILED; indistinguishable from a model
 *                           that deliberately declined
 *   2. unparseable JSON   — dropped
 *   3. missing enforcement— dropped
 *   4. catch {return null}— Pydantic's rejection reason discarded entirely
 *
 * So a synthesizer that never once produced a valid rule looked exactly like a
 * pipeline with nothing to learn. That is the B30 defect one layer up: a
 * mechanism doing nothing while reporting nothing.
 *
 * The fix is a visible quarantine (`unmapped-rules.jsonl`) capturing every
 * refusal WITH its reason, next to the two real stores. Quarantine is evidence,
 * never instruction: like the episodic log it is never read back to an agent, so
 * it cannot become a prompt-injection channel by the back door.
 *
 * A deliberate NO_CONSTRAINT refusal is also recorded, but marked as such — the
 * same three-valued discipline as the analyst: worked / deliberately declined /
 * broke must never share a representation.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'kb-quar-'));
  dirs.push(root);
  // Fresh module instances so configure({root}) is not shared between cases.
  for (const m of ['kb-store.js', 'kb-arbitration.js', 'kb-synthesizer.js']) {
    delete require.cache[require.resolve(join(LIB, m))];
  }
  const store = require(join(LIB, 'kb-store.js'));
  store.configure({ root });
  const synth = require(join(LIB, 'kb-synthesizer.js'));
  return { root, store, synth };
}

/** Stub standing in for ai-run.sh so no model is called. */
function stubRunner(body: string) {
  const d = mkdtempSync(join(tmpdir(), 'kb-runner-'));
  dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const SIG = 'TS2532';
const ROLE = 'impl-agent';

function seedEpisodes(store: any, n = 2) {
  for (let i = 0; i < n; i++) {
    store.recordEpisode({
      id: `ep-${i}-${Date.now()}`,
      signature: SIG,
      agent_role: ROLE,
      story_id: 'KB-TEST-1',
      diagnosis: 'object is possibly undefined',
    });
  }
}

function quarantine(root: string): any[] {
  const p = join(root, 'unmapped-rules.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

let ctx: ReturnType<typeof freshStore>;
beforeEach(() => { ctx = freshStore(); });

describe('Pillar 4 — every refused synthesis leaves evidence', () => {
  it('quarantines a FAILED runner instead of returning a silent null', async () => {
    seedEpisodes(ctx.store);
    const r = await ctx.synth.maybeSynthesize(ctx.store, {
      agent_role: ROLE, signature: SIG, runner: stubRunner('echo "boom" >&2; exit 1'),
    });
    expect(r).toBeFalsy();
    const q = quarantine(ctx.root);
    expect(q.length,
      'a broken synthesizer produced no record — indistinguishable from having nothing to learn').toBe(1);
    expect(q[0].outcome).toBe('no_output');
    expect(q[0].signature).toBe(SIG);
  });

  it('quarantines an unparseable reply, keeping the raw text as evidence', async () => {
    seedEpisodes(ctx.store);
    await ctx.synth.maybeSynthesize(ctx.store, {
      agent_role: ROLE, signature: SIG, runner: stubRunner('echo "I think you should just be careful"'),
    });
    const q = quarantine(ctx.root);
    expect(q.length).toBe(1);
    expect(q[0].outcome).toBe('unparseable');
    expect(q[0].raw).toMatch(/careful/);
  });

  it('quarantines a rule whose enforcement is outside the whitelist, with the reason', async () => {
    seedEpisodes(ctx.store);
    // kind:"advice" is exactly the prose-shaped "constraint" pillar 3 forbids.
    const bad = JSON.stringify({ enforcement: { kind: 'advice', text: 'be careful' }, reason: 'x' });
    await ctx.synth.maybeSynthesize(ctx.store, {
      agent_role: ROLE, signature: SIG, runner: stubRunner(`cat <<'EOF'\n${bad}\nEOF`),
    });
    const q = quarantine(ctx.root);
    expect(q.length).toBe(1);
    expect(q[0].outcome).toBe('unmapped_rule');
    expect(q[0].detail, 'the validation reason was discarded — nobody can tell WHY it was refused')
      .toBeTruthy();
    // And it must not have reached the procedural store.
    expect(ctx.store.readConstraints().length).toBe(0);
  });

  it('records a deliberate NO_CONSTRAINT as declined, not as a failure', async () => {
    seedEpisodes(ctx.store);
    await ctx.synth.maybeSynthesize(ctx.store, {
      agent_role: ROLE, signature: SIG, runner: stubRunner('echo NO_CONSTRAINT'),
    });
    const q = quarantine(ctx.root);
    expect(q.length).toBe(1);
    expect(q[0].outcome,
      'a deliberate decline must stay distinguishable from a broken synthesizer').toBe('declined');
  });

  it('admits a valid constraint and quarantines nothing', async () => {
    seedEpisodes(ctx.store);
    const good = JSON.stringify({
      enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '40' },
      reason: 'agent ran out of turns before writing the file',
    });
    const r = await ctx.synth.maybeSynthesize(ctx.store, {
      agent_role: ROLE, signature: SIG, runner: stubRunner(`cat <<'EOF'\n${good}\nEOF`),
    });
    expect(r, 'a valid proposal was not admitted').toBeTruthy();
    expect(ctx.store.readConstraints().length).toBe(1);
    expect(quarantine(ctx.root).length).toBe(0);
  });
});

describe('Pillar 4 — quarantine is evidence, never instruction', () => {
  it('is not readable through the retrieval path agents use', () => {
    const store = require(join(LIB, 'kb-store.js'));
    const src = readFileSync(join(LIB, 'kb-store.js'), 'utf8');
    // lookup() is what compiles into enforcement; it must never consult quarantine.
    const lookupBody = src.slice(src.indexOf('function lookup'), src.indexOf('function synthesize'));
    expect(lookupBody,
      'quarantined rules must never reach an agent — they failed validation for a reason')
      .not.toMatch(/unmapped|quarantine/i);
    expect(typeof store.lookup).toBe('function');
  });
});
