/**
 * A SEAM'S SI REACHES ONLY THE AGENTS THAT ARE THAT SEAM — NOT THE ONES THAT BORROW ITS LADDER.
 *
 * 2026-09-30, my defect: the hub resolved every call's SI by the seam its name maps to. The
 * registry's seamPatterns map whole name families to a seam to give them its LADDER ("the planning
 * family … the family cpa-inference already holds") — not its role. plan-producer, plan-reviewer,
 * story-plan-agent and the rest were each handed the Story Estimator's SI. Before that change none of
 * them received any role SI; each template states its own role.
 *
 * The universe is every caller the pipeline declares — each template id that resolves to a seam
 * carrying an si — never a sample. A name that IS the seam receives the seam's SI. A name that
 * reaches the seam only by the registry's name mapping never receives that seam's SI. Its LADDER is
 * unchanged.
 *
 * EXECUTED: the resolver the hub runs (lib/agent-si.js CLI), before the project roster exists.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam } = require(join(LIB, 'seam-invocation.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { constitution } = require(join(LIB, 'agent-contract.js'));

const callers = readdirSync(join(ROOT, 'orchestrations/prompts/templates'))
  .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  .map((name) => { try { return { name, seam: resolveSeam(name, undefined, { ignoreXref: true }) as string }; } catch { return null; } })
  .filter((c): c is { name: string; seam: string } => !!c && !!REG.profiles[c.seam] && !!REG.profiles[c.seam].si);
const isSeam = (c: { name: string; seam: string }) => c.name === c.seam;

const work = mkdtempSync(join(tmpdir(), 'si-callers-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
function siOf(name: string): string {
  const out = join(work, name);
  const r = spawnSync(process.execPath, [join(LIB, 'agent-si.js'), name, '', out], { encoding: 'utf8', env: { ...process.env, EPAM_SEAM: '', PROJECT_ROOT: '' } });
  expect(r.status, `${name}: ${r.stderr}`).toBe(0);
  return readFileSync(out, 'utf8');
}

describe('a seam\'s SI reaches only the agents that are that seam', () => {
  it('the universe is non-empty and holds both kinds of caller', () => {
    expect(callers.filter(isSeam).length).toBeGreaterThan(0);
    expect(callers.filter((c) => !isSeam(c)).length).toBeGreaterThan(0);
  });

  for (const c of callers) {
    if (isSeam(c)) {
      it(`${c.name}: is ${c.seam} — receives its SI`, () => {
        expect(siOf(c.name).startsWith(REG.profiles[c.seam].si)).toBe(true);
      });
    } else {
      it(`${c.name}: borrows ${c.seam}'s ladder only — never receives its SI`, () => {
        expect(siOf(c.name).trim()).toBe(constitution('').trim());
        // Its ladder is untouched: the name still resolves to the seam that decides its model.
        expect(resolveSeam(c.name, undefined, { ignoreXref: true })).toBe(c.seam);
      });
    }
  }
});
