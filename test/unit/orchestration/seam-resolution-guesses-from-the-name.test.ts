/**
 * AN AGENT DECLARES WHAT IT IS, AND SEAM RESOLUTION GUESSES FROM ITS NAME INSTEAD.
 *
 * Resolution order was: agentSeams (exact name) -> seamPatterns (name SHAPE) -> defaultSeam. Every
 * step keys off the name. The seamPatterns are suffix heuristics — '-engineer' and '-fixer' mean
 * story-writer, '-investigator' means code-graph-detective — written before proposals carried a
 * kind at all.
 *
 * Proposals now declare it outright: TOOL_PROJECT_AGENTS requires kind ∈ {implementer,
 * investigator}, and the mint prompt explains both. So the agent states its archetype and
 * resolution ignores the statement in favour of pattern-matching its name.
 *
 * Live 2026-08-17, run 20260817T181432Z. The mint proposed exactly the right roster —
 *
 *     + [implementer] typescript-vitest-implementer
 *
 * — and the run died: "'typescript-vitest-implementer' resolves to no seam: it is not a named
 * profile and no seamPattern matches it." A correctly declared implementer, refused because its
 * name ends in '-implementer' and the heuristics know '-engineer' and '-fixer'.
 *
 * This was induced by making the prompt document kind (the word 'implementer' became prominent, so
 * the model used it in the name) but the fragility predates that: any sensible name outside the
 * suffix list fails the same way, and the roster is model-authored, so the name is never ours.
 *
 * Adding '-implementer' to the suffix list would patch this instance and leave the class. The
 * declared kind is authoritative and already in the roster; resolution should read it, with the
 * name patterns kept as the fallback for agents that declare no kind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const REAL_REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));

let dir: string;
let registryFile: string;
let profilesFile: string;

const registry = () => JSON.parse(readFileSync(REAL_REGISTRY, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seam-kind-'));
  registryFile = join(dir, 'invocation-profiles.json');
  profilesFile = join(dir, 'profiles.json');
  writeFileSync(registryFile, JSON.stringify(registry()));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A roster holding one model-authored agent that declares its kind. */
function roster(name: string, kind: string) {
  writeFileSync(profilesFile, JSON.stringify({ [name]: { kind, brief: 'x' } }));
}

describe('seam resolution guesses from the name', () => {
  it('the EXISTING patterns say which kind they represent — no second table', () => {
    // The rules already name the seam and explain the role. Annotating them with the kind adds no
    // new mapping; a separate kind->seam table would be a second place to keep correct.
    const reg = registry();
    const withKind = reg.seamPatterns.filter((p: any) => p.kind);
    expect(withKind.length, 'no seamPattern declares the kind it serves').toBeGreaterThan(0);
    for (const p of withKind) {
      expect(reg.profiles[p.seam], `pattern ${p.match} names seam '${p.seam}', not a profile`).toBeTruthy();
    }
    const kinds = new Set(withKind.map((p: any) => p.kind));
    expect(kinds, 'no pattern serves an implementer').toContain('implementer');
    expect(kinds, 'no pattern serves an investigator').toContain('investigator');
  });

  it('THE LIVE CASE RESOLVES — a declared implementer whose name matches no pattern', () => {
    roster('typescript-vitest-implementer', 'implementer');
    const expected = registry().seamPatterns.find((p: any) => p.kind === 'implementer').seam;
    expect(resolveSeam('typescript-vitest-implementer', registryFile, { profilesFile })).toBe(expected);
  });

  it('a declared investigator resolves by kind too', () => {
    roster('mocka-fare-reader', 'investigator');
    const expected = registry().seamPatterns.find((p: any) => p.kind === 'investigator').seam;
    expect(resolveSeam('mocka-fare-reader', registryFile, { profilesFile })).toBe(expected);
  });

  it('AN EXACT agentSeams ENTRY STILL WINS — the most specific statement about one agent', () => {
    const reg = registry();
    reg.agentSeams = { ...(reg.agentSeams || {}), 'odd-implementer': 'roster-review' };
    writeFileSync(registryFile, JSON.stringify(reg));
    roster('odd-implementer', 'implementer');
    expect(resolveSeam('odd-implementer', registryFile, { profilesFile })).toBe('roster-review');
  });

  it('the name patterns still work for an agent that declares NO kind', () => {
    // Canonical agents carry no kind; their resolution must not change.
    roster('some-engineer', '');
    expect(resolveSeam('some-engineer', registryFile, { profilesFile })).toBe('story-writer');
  });

  it('an unknown kind falls through to the patterns rather than resolving wrongly', () => {
    // Inventing a seam for a kind nobody declared is worse than reporting the gap.
    roster('weird-engineer', 'archivist');
    expect(resolveSeam('weird-engineer', registryFile, { profilesFile })).toBe('story-writer');
  });

  it('an unresolvable agent still fails loudly', () => {
    roster('nothing-matches-this', '');
    expect(() => resolveSeam('nothing-matches-this', registryFile, { profilesFile }))
      .toThrow(/resolves to no seam/);
  });

  it('resolution works when no roster is readable at all', () => {
    // seamInvocationEnv is called from processes that never load profiles.json; kind lookup must
    // be best-effort and never turn a working resolution into a crash.
    expect(resolveSeam('some-engineer', registryFile, { profilesFile: join(dir, 'nope.json') }))
      .toBe('story-writer');
  });
});
