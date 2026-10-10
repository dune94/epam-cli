/**
 * THE SI AUDIT IS TRUSTED ONLY ON CASES WHOSE ANSWER IS KNOWN.
 *
 * Operator, 2026-09-29: "How will you know if you build it that it will work?" — by running it
 * on SIs whose defects are known (the operator's reviewer draft says REJECT/ACCEPT and frames the
 * seam as brownfield-only) and on the stored base SI (must be clean), and by mutating the clean one
 * (md5-checked) so each exact check is seen to fire on the one change that should trip it.
 *
 * Nothing here names a verdict word, a tool or a project kind: every expectation is read from the
 * same declarations the audit reads, so a registry change moves the test with it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(ROOT, 'orchestrations', 'scripts', 'tools', 'si-audit.js');
const FIX = path.join(ROOT, 'test', 'fixtures', 'si-audit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const audit = require(TOOL);
const registry = JSON.parse(readFileSync(path.join(ROOT, 'orchestrations', 'agents', 'invocation-profiles.json'), 'utf8'));
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function run(seam: string, siText: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'si-audit-test-'));
  const file = path.join(dir, 'si.md');
  writeFileSync(file, siText);
  const r = spawnSync(process.execPath, [TOOL, '--seam', seam, '--si', file, '--facts-only'], { encoding: 'utf8' });
  expect(r.status, r.stderr).not.toBe(2);
  const out = JSON.parse(r.stdout);
  expect(out.facts.length).toBeGreaterThan(3);          // not a vacuous sheet
  return { status: r.status, out };
}

const SEAM = 'team-lead-review';
const facts = audit.factSheet(SEAM);
const draft = readFileSync(path.join(FIX, `${SEAM}.operator-draft.md`), 'utf8');
// The stored base SI, from the one place it lives — never a copy.
const proposed: string = registry.profiles[SEAM].si;

describe('the fact sheet is the declarations', () => {
  it('derives every seam without error, and a brownfield-only producer is never available in the other kind', () => {
    const kinds: string[] = audit.projectKinds();
    expect(kinds.length).toBeGreaterThan(1);
    let checked = 0;
    for (const seam of Object.keys(registry.profiles)) {
      const f = audit.factSheet(seam);
      for (const i of f.inputs) {
        if (i.engine || !i.producers.length) continue;
        for (const k of kinds) {
          const anyRuns = i.producers.some((p: string) => {
            const a = registry.profiles[p].appliesTo;
            return !Array.isArray(a) || a.includes(k) || a.some((m: string) => !kinds.includes(m));
          });
          if (!anyRuns) { expect(i.byKind[k]).toBe('never'); checked += 1; }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);                   // the property was exercised, not skipped
  });

  it('reads the answer values from the template body', () => {
    const tpl = JSON.parse(readFileSync(path.join(ROOT, 'orchestrations', 'prompts', 'templates', `${registry.profiles[SEAM].template}.json`), 'utf8'));
    for (const key of facts.contract.requiredKeys) {
      expect(facts.answer[key]?.length).toBeGreaterThan(1);
      for (const v of facts.answer[key]) expect(tpl.body).toContain(`"${key}":"${v}"`);
    }
  });
});

describe('known answers', () => {
  it('the operator draft: flags the outcome words and the single project kind', () => {
    const { status, out } = run(SEAM, draft);
    expect(status).toBe(1);
    expect(out.exact.map((x: { check: string }) => x.check).sort()).toEqual(['kind', 'outcome']);
  });

  it('the stored base SI: clean', () => {
    expect(proposed.length).toBeGreaterThan(0);
    const { status, out } = run(SEAM, proposed);
    expect(out.exact).toEqual([]);
    expect(status).toBe(0);
  });
});

describe('mutations of the clean SI each trip exactly their check', () => {
  const key = facts.contract.requiredKeys[0];
  const value = facts.answer[key][facts.answer[key].length - 1];
  const kinds = audit.projectKinds() as string[];
  const denied = facts.allTools.filter((t: string) => !facts.grantTools.includes(t));

  const cases: Array<[string, string, string]> = [
    ['outcome', value, 'rejected'],
    ['kind', kinds[0], 'codeline'],
    ['tool', '# Output Protocol', `Never call ${denied[0]}.\n\n# Output Protocol`],
  ];
  for (const [check, from, to] of cases) {
    it(`${check}: ${from} -> ${to}`, () => {
      const mutated = proposed.split(from).join(to);
      expect(md5(mutated)).not.toBe(md5(proposed));        // the mutation applied
      const { status, out } = run(SEAM, mutated);
      expect(status).toBe(1);
      expect(out.exact.map((x: { check: string }) => x.check)).toEqual([check]);
    });
  }

  it('naming a GRANTED tool is not a finding', () => {
    const mutated = `${proposed}\nUse ${facts.grantTools[facts.grantTools.length - 1]} to run the tests.\n`;
    expect(md5(mutated)).not.toBe(md5(proposed));
    expect(run(SEAM, mutated).out.exact).toEqual([]);
  });
});
