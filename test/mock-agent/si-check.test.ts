/**
 * THE SI CHECK ITSELF — it passes a call that carries its SI and task, and names every way one can not.
 * The calls are built from the repository's own declarations: a seam's registry SI and the constitution
 * rendered by the engine's renderer. A check that passed everything would make every run's SI
 * assertion vacuous.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siFindings, hostFindings, personaInPrompt } from './si-check';
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
  it('a call the mock cannot attribute still needs exactly one seam\'s SI', () => {
    expect(siFindings(call(`${reg[SEAM].si}\n\n${RULES}`, 'THE TASK', 'UNRECOGNISED'), ORCH)).toEqual([]);
    expect(siFindings(call(RULES, 'THE TASK', 'UNRECOGNISED'), ORCH).some((f) => /no SI of any seam/.test(f))).toBe(true);
    expect(siFindings(call(`${reg[SEAM].si}\n${reg[OTHER].si}\n${RULES}`, 'THE TASK', 'UNRECOGNISED'), ORCH).some((f) => /more than one seam/.test(f))).toBe(true);
  });
  it('names the host\'s CLAUDE.md reaching the request', () => {
    const claudeMd = readFileSync(join(ORCH, '..', 'CLAUDE.md'), 'utf8').split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 12);
    expect(claudeMd, 'the repository has no CLAUDE.md to prove this with').toBeTruthy();
    expect(hostFindings(call('SI', `${claudeMd}\nTHE TASK`), ORCH).join(' ')).toMatch(/host CLAUDE\.md/);
    expect(hostFindings(call('SI', 'THE TASK'), ORCH)).toEqual([]);
    // The runner's OWN system prompt is not host configuration: only what reached the task counts.
    expect(hostFindings(call(`${claudeMd}\nSI`, 'THE TASK'), ORCH)).toEqual([]);
  });
  it('names an SI or persona pasted into the prompt — one path only', () => {
    expect(personaInPrompt(call(`${reg[SEAM].si}\n\n${RULES}`, 'THE PROMPT'), ORCH)).toEqual([]);
    expect(personaInPrompt(call(RULES, `${reg[SEAM].si}\n\nTHE PROMPT`), ORCH).join(' ')).toMatch(/inside the prompt/);
    // A persona in profiles.json whose name resolves to a seam: that seam's call may not carry it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveSeam } = require(join(ORCH, 'scripts/lib/seam-invocation.js'));
    const profiles = JSON.parse(readFileSync(join(ORCH, 'agents/profiles.json'), 'utf8'));
    const [name, persona] = Object.entries<any>(profiles).map(([n, v]) => [n, typeof v === 'string' ? v : v && v.persona] as [string, string])
      .find(([n, v]) => typeof v === 'string' && v.length > 80 && (() => { try { return !!resolveSeam(n, undefined, { ignoreXref: true }); } catch { return false; } })()) as [string, string];
    expect(persona, 'profiles.json holds no seam-resolvable persona to prove this with').toBeTruthy();
    const itsSeam = resolveSeam(name, undefined, { ignoreXref: true });
    expect(personaInPrompt(call(RULES, `${persona}\n\nTHE PROMPT`, itsSeam), ORCH).join(' ')).toMatch(/inside the prompt \(profile /);
    // ANOTHER agent's SI as the subject of the prompt (a roster reviewer reads the roster) is not its identity.
    const [a, b] = Object.keys(reg).filter((x) => reg[x].si);
    expect(personaInPrompt(call(RULES, `ROSTER UNDER REVIEW:\n${reg[b].si}`, a), ORCH)).toEqual([]);
    // …including the reviewer's OWN entry, when the roster under review carries others too.
    expect(personaInPrompt(call(RULES, `ROSTER UNDER REVIEW:\n${reg[a].si}\n${reg[b].si}`, a), ORCH)).toEqual([]);
    // Its own SI ALONE in the prompt is a pasted identity.
    expect(personaInPrompt(call(RULES, `${reg[a].si}\n\nTHE PROMPT`, a), ORCH).length).toBe(1);
  });
});
