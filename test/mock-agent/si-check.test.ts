/**
 * THE SI CHECK ITSELF — it passes a call that carries its SI and task, and names every way one can not.
 * The calls are built from the repository's own declarations: a seam's registry SI and the constitution
 * rendered by the engine's renderer. A check that passed everything would make every run's SI
 * assertion vacuous.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siFindings, hostFindings } from './si-check';
import type { Call } from './agent';

const ORCH = join(__dirname, '../../orchestrations');
const reg = JSON.parse(readFileSync(join(ORCH, 'agents/invocation-profiles.json'), 'utf8')).profiles;
const [SEAM, OTHER] = Object.keys(reg).filter((s) => reg[s].si);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { constitution } = require(join(ORCH, 'scripts/lib/agent-contract.js'));
const RULES = constitution('/some/root');

const call = (system: string, task: string, seam = SEAM): Call => ({ n: 1, seam, template: '', coverage: 1, story: '', attempt: 1,
  req: { system, messages: [{ role: 'user', text: task }], tools: [] } as any });

describe('the SI check', () => {
  it('passes a call carrying its seam\'s SI, the constitution and a separate task', () => {
    expect(siFindings(call(`${reg[SEAM].si}\n\n${RULES}`, 'THE TASK'), ORCH)).toEqual([]);
  });
  it('names a call with no system prompt', () => {
    expect(siFindings(call('', 'THE TASK'), ORCH)).toContain('no system prompt');
  });
  it('names a call with no task', () => {
    expect(siFindings(call(`${reg[SEAM].si}\n\n${RULES}`, ''), ORCH)).toContain('no task');
  });
  it('names a call without the constitution', () => {
    expect(siFindings(call(reg[SEAM].si, 'THE TASK'), ORCH)).toContain('no constitution');
  });
  it('names a call with only the constitution — no SI of its seam', () => {
    expect(siFindings(call(RULES, 'THE TASK'), ORCH)).toContain(`no SI of seam ${SEAM}`);
  });
  it('names a call carrying ANOTHER seam\'s SI', () => {
    const f = siFindings(call(`${reg[OTHER].si}\n\n${RULES}`, 'THE TASK'), ORCH);
    expect(f).toContain(`no SI of seam ${SEAM}`);
    expect(f).toContain(`carries ${OTHER}'s SI`);
  });
  it('names the SI travelling inside the task', () => {
    const sys = `${reg[SEAM].si}\n\n${RULES}`;
    expect(siFindings(call(sys, `${sys}\n\nTHE TASK`), ORCH)).toContain('the SI travelled inside the task');
  });
  it('names a call no declared seam accounts for', () => {
    expect(siFindings(call('x', 'THE TASK', 'UNRECOGNISED'), ORCH).some((f) => /not attributable/.test(f))).toBe(true);
  });
  it('names the host\'s CLAUDE.md reaching the request', () => {
    const claudeMd = readFileSync(join(ORCH, '..', 'CLAUDE.md'), 'utf8').split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 12);
    expect(claudeMd, 'the repository has no CLAUDE.md to prove this with').toBeTruthy();
    expect(hostFindings(call('SI', `${claudeMd}\nTHE TASK`), ORCH).join(' ')).toMatch(/host CLAUDE\.md/);
    expect(hostFindings(call('SI', 'THE TASK'), ORCH)).toEqual([]);
  });
});
