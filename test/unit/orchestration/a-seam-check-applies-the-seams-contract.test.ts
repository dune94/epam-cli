/**
 * A SEAM CHECK APPLIES THE SEAM'S CONTRACT, NOT JUST ITS ABILITY TO ANSWER.
 *
 * On 2026-08-23 the per-agent harness reported two seams green while they produced work the real
 * run would have refused outright:
 *
 *   roster-specialiser     wrote 38 of the 57 canonical agents. project-roster.js:155 states the
 *                          contract — "whatever canonical holds, the roster holds, no subset
 *                          logic anywhere" — and buildProjectRoster re-prompts with the gap. The
 *                          harness called the seam raw, so nothing applied it. 19 agents would
 *                          have had no identity at the moment the pipeline invoked them.
 *
 *   project-roster-review  answered 'nothing_to_review'. spec-mode-runner maps that to
 *                          review_failed on purpose — the judge did not look, the artefact is not
 *                          implicated, retry the judge. The harness saw well-formed JSON and
 *                          called it a pass, which is the precise failure the schema's three-way
 *                          distinction exists to prevent.
 *
 * Neither was a pipeline defect; the architecture already handled both. The defect was a check
 * that stopped at "it answered". These assertions use the REAL artefacts those seams produced.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const harness = require(join(__dirname, '../../../orchestrations/scripts/agent-check.js'));
const CANONICAL = join(__dirname, '../../../orchestrations/agents/profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(join(__dirname, '../../../orchestrations/scripts/lib/project-roster.js'));

/** A sandbox holding a roster with only the first `n` canonical agents in it. */
const sandboxWith = (n: number): string => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-contract-'));
  mkdirSync(join(dir, 'sandbox'), { recursive: true });
  const raw = JSON.parse(readFileSync(CANONICAL, 'utf8'));
  const flat = raw.agents && typeof raw.agents === 'object' ? raw.agents : raw;
  const names = Object.keys(flat).filter((k) => {
    const v = flat[k];
    return typeof v === 'string' ? v.trim() : String((v && v.persona) || '').trim();
  });
  const agents: Record<string, unknown> = {};
  for (const name of names.slice(0, n)) {
    const v = flat[name];
    const persona = typeof v === 'string' ? v : String((v && v.persona) || '');
    // PROVENANCE IS PART OF THE CONTRACT. checkRoster requires each entry to carry the digest of
    // the ancestor persona it derives from, so a fixture without one is refused for a reason that
    // has nothing to do with completeness — which is what this case is actually about.
    agents[name] = {
      persona,
      kind: 'seam',
      ancestor: name,
      derivedFromSha256: roster.personaDigest(persona),
    };
  }
  writeFileSync(join(dir, 'sandbox', 'agent-profiles.json'), JSON.stringify({ agents }));
  return dir;
};

const canonicalCount = (): number => {
  const raw = JSON.parse(readFileSync(CANONICAL, 'utf8'));
  const flat = raw.agents && typeof raw.agents === 'object' ? raw.agents : raw;
  return Object.keys(flat).filter((k) => {
    const v = flat[k];
    return typeof v === 'string' ? v.trim() : String((v && v.persona) || '').trim();
  }).length;
};

describe('a produced roster is held to the roster contract', () => {
  it('REFUSES an incomplete roster, naming what is missing', () => {
    const total = canonicalCount();
    expect(total, 'no canonical agents — this test would prove nothing').toBeGreaterThan(10);
    const dir = sandboxWith(total - 5);
    const v = harness.contractVerdict('roster-specialiser', '', { outDir: dir });
    expect(v.ok, 'an incomplete roster was accepted').toBe(false);
    expect(v.why, 'the refusal does not say what is absent').toMatch(/absent from the roster/);
  });

  it('accepts a complete one', () => {
    const dir = sandboxWith(canonicalCount());
    const v = harness.contractVerdict('roster-specialiser', '', { outDir: dir });
    expect(v.ok, `a complete roster was refused: ${v.why}`).toBe(true);
  });

  it('refuses a producer that wrote nothing at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-contract-empty-'));
    const v = harness.contractVerdict('roster-specialiser', '', { outDir: dir });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/wrote no roster/);
  });
});

describe('a review that did not look is not a pass', () => {
  const ctx = { outDir: tmpdir() };

  it("refuses 'nothing_to_review' — the verdict that means the judge did not examine", () => {
    const v = harness.contractVerdict('project-roster-review',
      JSON.stringify({ findings: [], verdict: 'nothing_to_review' }), ctx);
    expect(v?.ok, "'nothing_to_review' was accepted as a passing review").toBe(false);
  });

  it('lets an examined-and-sound verdict through', () => {
    expect(harness.contractVerdict('project-roster-review',
      JSON.stringify({ verdict: 'sound', findings: [] }), ctx)).toBeNull();
  });

  it('lets an examined-and-defective verdict through — findings are not a check failure', () => {
    expect(harness.contractVerdict('project-roster-review',
      JSON.stringify({ verdict: 'defects_found', findings: [{ agent: 'x' }] }), ctx)).toBeNull();
  });

  it('accepts a findings-only reviewer with a genuinely empty list', () => {
    // survey-review's own prompt says an empty finding list from a review that RAN is correct.
    expect(harness.contractVerdict('survey-review', JSON.stringify({ findings: [] }), ctx)).toBeNull();
  });
});
