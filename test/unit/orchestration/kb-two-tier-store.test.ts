/**
 * PILLAR 1 — episodic failures and procedural knowledge are SEPARATE stores.
 *
 * Today there is one flat markdown KB (KB.md, KB-<role>.md) injected wholesale into
 * prompts, and a separate healing-events.jsonl nobody synthesises from. Flattening
 * "what happened" together with "the rule" confuses chronological truth: an agent
 * reading raw failure prose cannot tell a transient error from a permanent rule.
 *
 *   EPISODIC   = what happened. Append-only, immutable, never read by an agent.
 *   PROCEDURAL = the deduplicated rule. Structured, keyed, machine-enforceable.
 *
 * Retrieval is a deterministic keyed lookup on (agentRole, signature) — NOT vector
 * similarity, NOT a graph. Similarity search over failure logs is what produces the
 * over-correction and context bloat this design exists to avoid.
 *
 * PILLAR 3 is enforced at the schema level: `enforcement` is a discriminated union
 * over three compile targets, so a constraint that is only prose CANNOT BE
 * CONSTRUCTED. That is the admission rule — not a check someone can forget to run.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
let store: any;
let dir: string;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kb-store-')); dirs.push(dir);
  store = require(join(LIB, 'kb-store.js'));
  store.configure({ root: dir });
});

const constraint = (over: any = {}) => ({
  id: 'ts-no-unnarrowed-optional',
  scope: { agent_role: 'typescript-engineer' },
  trigger: { signature: 'TS2532' },
  enforcement: { kind: 'gate', check: 'no-unnarrowed-optional-access' },
  reason: 'strict null checks reject optional access without narrowing',
  origin_episodes: ['evt-1'],
  ...over,
});

describe('Pillar 1 — the two stores are separate', () => {
  it('an episodic event is append-only and never mutates a prior record', () => {
    store.recordEpisode({ id: 'evt-1', story_id: 'S-1', agent_role: 'typescript-engineer',
      signature: 'TS2532', diagnosis: 'optional accessed without narrowing', phase: 'core' });
    store.recordEpisode({ id: 'evt-2', story_id: 'S-1', agent_role: 'typescript-engineer',
      signature: 'TS2532', diagnosis: 'same again', phase: 'core' });
    const eps = store.episodes();
    expect(eps.map((e: any) => e.id)).toEqual(['evt-1', 'evt-2']);
    expect(eps[0].diagnosis).toBe('optional accessed without narrowing');
  });

  it('episodic records carry a timestamp so chronology is never ambiguous', () => {
    store.recordEpisode({ id: 'evt-1', story_id: 'S-1', agent_role: 'r', signature: 'X', diagnosis: 'd' });
    expect(store.episodes()[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('procedural constraints live in a DIFFERENT file from episodes', () => {
    store.recordEpisode({ id: 'evt-1', story_id: 'S-1', agent_role: 'r', signature: 'X', diagnosis: 'd' });
    store.putConstraint(constraint());
    expect(existsSync(join(dir, 'healing-events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'constraints.json'))).toBe(true);
    expect(readFileSync(join(dir, 'constraints.json'), 'utf8')).not.toContain('optional accessed without narrowing');
  });
});

describe('Pillar 1 — retrieval is a deterministic keyed lookup', () => {
  beforeEach(() => {
    store.putConstraint(constraint());
    store.putConstraint(constraint({ id: 'other-role', scope: { agent_role: 'test-engineer' } }));
    store.putConstraint(constraint({ id: 'other-sig', trigger: { signature: 'TS1005' } }));
  });

  it('returns only constraints matching BOTH role and signature', () => {
    const hits = store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' });
    expect(hits.map((c: any) => c.id)).toEqual(['ts-no-unnarrowed-optional']);
  });

  it('returns nothing for an unrelated signature — no fuzzy matching', () => {
    expect(store.lookup({ agent_role: 'typescript-engineer', signature: 'TS9999' })).toEqual([]);
  });

  it('global-scope constraints apply to every role', () => {
    store.putConstraint(constraint({ id: 'global-rule', scope: { global: true }, trigger: { signature: 'TS2532' } }));
    const hits = store.lookup({ agent_role: 'anything', signature: 'TS2532' });
    expect(hits.map((c: any) => c.id)).toContain('global-rule');
  });
});

describe('Pillar 3 (admission) — a constraint MUST compile to an enforcement mechanism', () => {
  it('rejects a constraint whose enforcement is missing', () => {
    const c: any = constraint(); delete c.enforcement;
    expect(() => store.putConstraint(c)).toThrow(/enforcement/i);
  });

  it('rejects a PROSE-ONLY constraint — the whole point of pillar 3', () => {
    expect(() => store.putConstraint(constraint({
      enforcement: { kind: 'note', text: 'try to remember to narrow optionals' },
    }))).toThrow(/enforcement|kind/i);
  });

  it('accepts the three real compile targets', () => {
    for (const enforcement of [
      { kind: 'gate', check: 'no-unnarrowed-optional-access' },
      { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '12' },
      { kind: 'tool_scope', allowed_write_paths: 'src/svc/discount.ts' },
    ]) {
      // ids are kebab-case slugs — `tool_scope` must be normalised, not passed raw
      const id = `c-${enforcement.kind.replace(/_/g, '-')}`;
      expect(() => store.putConstraint(constraint({ id, enforcement }))).not.toThrow();
    }
  });

  it('rejects a malformed record rather than writing a partial store', () => {
    const before = readFileSync(join(dir, 'constraints.json'), 'utf8');
    expect(() => store.putConstraint({ id: 'broken' } as any)).toThrow();
    expect(readFileSync(join(dir, 'constraints.json'), 'utf8')).toBe(before);
  });
});

describe('Pillar 1 — synthesis turns episodes into ONE deduplicated rule', () => {
  it('N episodes of the same signature yield a single constraint citing them all', () => {
    for (const id of ['evt-1', 'evt-2', 'evt-3'])
      store.recordEpisode({ id, story_id: 'S-1', agent_role: 'typescript-engineer',
        signature: 'TS2532', diagnosis: 'optional accessed without narrowing' });
    const made = store.synthesize({ agent_role: 'typescript-engineer', signature: 'TS2532',
      enforcement: { kind: 'gate', check: 'no-unnarrowed-optional-access' },
      reason: 'repeated strict-null failure' });
    expect(made.origin_episodes).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(store.lookup({ agent_role: 'typescript-engineer', signature: 'TS2532' })).toHaveLength(1);
  });

  it('re-synthesising the same signature MERGES rather than appending a duplicate', () => {
    store.recordEpisode({ id: 'evt-1', story_id: 'S-1', agent_role: 'r', signature: 'X', diagnosis: 'd' });
    const spec = { agent_role: 'r', signature: 'X',
      enforcement: { kind: 'gate', check: 'c' }, reason: 'r' };
    store.synthesize(spec);
    store.recordEpisode({ id: 'evt-2', story_id: 'S-2', agent_role: 'r', signature: 'X', diagnosis: 'd' });
    const second = store.synthesize(spec);
    expect(store.lookup({ agent_role: 'r', signature: 'X' })).toHaveLength(1);
    expect(second.origin_episodes).toEqual(['evt-1', 'evt-2']);
  });
});
