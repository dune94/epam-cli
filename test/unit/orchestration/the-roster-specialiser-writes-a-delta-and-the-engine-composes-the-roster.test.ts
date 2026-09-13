/**
 * THE ROSTER SPECIALISER WRITES A DELTA; THE ENGINE COMPOSES THE ROSTER.
 *
 * Run 20260913T002259Z (regintel, second attempt after the grant fix) failed at the same step and
 * said why, in the agent's own status text: read_file returns 8,192 characters and the canonical
 * roster is ~133,000 on 50 lines, so fourteen turns of reading reached line 10; the contract
 * demanded a SHA-256 per entry and the agent had no way to compute one, so it emitted
 * COMPUTE:/REPLACE_WITH_SHA256 sentinels rather than fabricate (correctly); and the tool budget
 * ran out before any write. $1.02, three attempts, no roster.
 *
 * The contract was the defect. The digest is a function of the ancestor's canonical persona,
 * which the engine holds; reproducing 57 personas verbatim is copying, not specialising. Now the
 * agent writes only what it specialises or adds, reads one persona per file, and the engine
 * composes the roster and records provenance. Every case executes the real library; the last
 * drives buildProjectRoster end to end with a stub specialiser that writes a delta.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(join(ROOT, 'orchestrations/scripts/lib/project-roster.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const CANON = { alpha: 'alpha does A, generically', beta: 'beta does B, generically', gamma: 'gamma does C, generically' };

describe('the canonical copy is readable one persona at a time', () => {
  it('copyCanonicalForRun writes <agent>.txt per persona beside the JSON copy', () => {
    const d = tmp('canon-'); const f = join(d, 'profiles.canonical.json'); writeFileSync(f, JSON.stringify(CANON));
    const logDir = join(d, 'logs'); mkdirSync(logDir);
    const copy = roster.copyCanonicalForRun(f, logDir);
    const dir = roster.canonicalCopyDir(logDir);
    expect(dir).not.toBe(copy);
    expect(readdirSync(dir).sort()).toEqual(['alpha.txt', 'beta.txt', 'gamma.txt']);
    expect(readFileSync(join(dir, 'beta.txt'), 'utf8')).toBe(CANON.beta);
  });
});

describe('composeFromDelta', () => {
  it('a specialised entry keeps its name as ancestor and takes the ENGINE\'s digest of the canonical persona', () => {
    const { roster: r, specialised, adopted } = roster.composeFromDelta({ agents: { alpha: { persona: 'alpha, for this project' } } }, CANON);
    expect(r.agents.alpha.persona).toBe('alpha, for this project');
    expect(r.agents.alpha.ancestor).toBe('alpha');
    expect(r.agents.alpha.derivedFromSha256).toBe(sha(CANON.alpha));
    expect(specialised).toBe(1); expect(adopted).toBe(2);
  });
  it('an unmentioned canonical agent is adopted verbatim — never missing', () => {
    const { roster: r } = roster.composeFromDelta({ agents: {} }, CANON);
    expect(Object.keys(r.agents).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(r.agents.gamma.persona).toBe(CANON.gamma);
    expect(r.agents.gamma.derivedFromSha256).toBe(sha(CANON.gamma));
  });
  it('an added agent derives from its named ancestor, inherits its kind, and carries that ancestor\'s digest', () => {
    const { roster: r, added } = roster.composeFromDelta({ agents: { delta: { persona: 'new', ancestor: 'beta', seam: 'story-writer' } } }, CANON);
    expect(added).toBe(1);
    expect(r.agents.delta.ancestor).toBe('beta');
    expect(r.agents.delta.kind).toBe(r.agents.beta.kind);
    expect(r.agents.delta.derivedFromSha256).toBe(sha(CANON.beta));
  });
  it('a digest the agent wrote itself is overwritten — the engine\'s is the only real one', () => {
    const { roster: r } = roster.composeFromDelta({ agents: { alpha: { persona: 'x', derivedFromSha256: 'REPLACE_WITH_SHA256' } } }, CANON);
    expect(r.agents.alpha.derivedFromSha256).toBe(sha(CANON.alpha));
  });
  it('an ancestor canonical does not have is left for the contract check to refuse, by name', () => {
    const { roster: r } = roster.composeFromDelta({ agents: { omega: { persona: 'x', ancestor: 'nobody', kind: 'implementer' } } }, CANON);
    const v = roster.checkRoster(r, CANON);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/ancestor 'nobody' is not in canonical/);
  });
});

describe('buildProjectRoster, end to end, with a specialiser that writes only a delta', () => {
  it('lands a complete roster on disk that satisfies the contract, and the review sees it', async () => {
    const d = tmp('build-');
    const canonicalPath = join(d, 'profiles.canonical.json'); writeFileSync(canonicalPath, JSON.stringify(CANON));
    const logDir = join(d, 'logs'); mkdirSync(logDir);
    const projectConfigDir = join(d, 'project'); mkdirSync(projectConfigDir);
    const seen: string[] = [];
    const produce = async ({ outPath, canonicalCopyPath }: any) => {
      // What a specialiser now does: read one persona, write the delta, no digest, no shell.
      expect(existsSync(roster.canonicalCopyDir(logDir))).toBe(true);
      expect(existsSync(canonicalCopyPath)).toBe(true);
      writeFileSync(outPath, JSON.stringify({ agents: { alpha: { persona: 'alpha, against THIS codeline', rationale: 'the generic one names no framework' } } }));
    };
    const review = async ({ roster: r }: any) => { seen.push(...Object.keys(r.agents)); return { verdict: 'approved', findings: [] }; };
    const out = await roster.buildProjectRoster({ canonicalPath, logDir, projectConfigDir, produce, review, attempts: 1, log: () => {} });
    expect(Object.keys(out.agents).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(out.agents.alpha.persona).toBe('alpha, against THIS codeline');
    expect(out.agents.alpha.derivedFromSha256).toBe(sha(CANON.alpha));
    expect(out.agents.beta.persona).toBe(CANON.beta);
    const onDisk = JSON.parse(readFileSync(roster.projectRosterPath(projectConfigDir), 'utf8'));
    expect(roster.checkRoster(onDisk, CANON).ok).toBe(true);
    expect(seen.sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('the contract the agent is handed says so: no digest asked for, one persona per file, write only the delta', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/roster-specialisation.json'), 'utf8'));
    expect(tpl.placeholders).toContain('__CANONICAL_DIR__');
    expect(tpl.body).not.toMatch(/derivedFromSha256.*sha256 of/i);
    expect(tpl.body).not.toMatch(/EVERY AGENT IN THE CANONICAL ROSTER MUST APPEAR/);
    expect(tpl.body).toMatch(/adopted verbatim/);
    expect(tpl.body).toMatch(/ONLY the agents you specialised or added/);
  });
});
