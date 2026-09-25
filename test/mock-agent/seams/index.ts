/**
 * EVERY SEAM'S CORRECT BEHAVIOUR, IN ONE PLACE.
 *
 * A seam with its own module answers with the values a diligent model would give, drawn from the
 * request and the world; every other seam answers in the format its prompt renders, with neutral
 * values. Adding a seam's realism is adding one entry here — the format, the contract and the
 * reconciliation are shared and read from the code at call time.
 */
import type { Behaviour, Call } from '../agent';
import { defaultAnswer, renderedFor, type Filler } from '../answer';
import type { Field } from '../rendered-schema';
import type { World } from '../world';
import type { Contract } from '../declarations';
import { estateSurvey } from './survey';
import { judges, judgeFindsNothing } from './judge';
import { agentMint } from './mint';
import { rosterDelta } from './roster';
import { roleAssigner } from './assign';
import { segmented } from './segments';
import { writerDelivers } from './writer';
import { testCriteria } from './tc';
import { failureAnalyst } from './analyst';

type FillerFor = (world: World, prompt: string, fields: Field[], call: Call) => Filler;

/** Seams whose values need knowledge of the world. The rest take the neutral default. */
export const FILLERS: Record<string, FillerFor> = {
  'estate-survey': (w, p) => estateSurvey(w, p),
  'agent-mint': (w, p, f) => agentMint(w, p, f),
  'role-assigner': (w, p, f) => roleAssigner(w, p, f),
};

/** Seams whose whole answer is built from the world rather than from a rendered schema. */
export const WHOLE: Record<string, (world: World, prompt: string, call: Call, contract?: Contract) => string> = {
  'tc-writer': (w, p, _c, k) => testCriteria(w, p, k),
  'roster-specialiser': (w, p) => JSON.stringify(rosterDelta(w, p)),
  'prompt-builder': (w, p) => segmented(w, p) ?? 'OK',
};

/** A contract that declares a tag is answered inside it, whatever style the prompt rendered its shape in. */
export const wrapped = (text: string, contract?: Contract) => (contract?.tag && !text.includes(`<${contract.tag}>`) ? `<${contract.tag}>\n${text}\n</${contract.tag}>` : text);

export const promptOf = (call: Call) => `${call.req.system}\n${call.req.messages.find((m) => m.role === 'user')?.text || ''}`;

/**
 * Answers keyed by TEMPLATE, for a seam reached through several templates with different formats
 * (impl-failure-analyst answers a failure diagnosis, a phase assessment and a gate finding).
 */
export const BY_TEMPLATE: Record<string, (world: World, prompt: string, call: Call, contract?: Contract) => string> = {
  'failure-analyst': (w, p, c, k) => failureAnalyst(w, p, c.story, k),
};

/** Seams that ACT through tools, turn by turn, rather than answer in one reply. */
export const ACTING: Record<string, (world: World, install: string) => Behaviour> = {
  'story-writer': (w, i) => writerDelivers(w, i),
};

/** The behaviour of a model that does each seam's job correctly. */
export function correct(world: World, install: string): Behaviour {
  const acting = Object.fromEntries(Object.entries(ACTING).map(([k, f]) => [k, f(world, install)]));
  return (call, agent) => {
    if (acting[call.seam]) return acting[call.seam](call, agent);
    const prompt = promptOf(call);
    const contract = agent.decl.contractOf(call.seam);
    if (BY_TEMPLATE[call.template]) return { kind: 'text', text: wrapped(BY_TEMPLATE[call.template](world, prompt, call, contract), contract) };
    if (WHOLE[call.seam]) return { kind: 'text', text: wrapped(WHOLE[call.seam](world, prompt, call, contract), contract) };
    const fields = renderedFor(prompt, contract)?.fields || [];
    const filler = FILLERS[call.seam]?.(world, prompt, fields, call)
      ?? (judges(agent.decl.registry[call.seam]?.produces) ? judgeFindsNothing() : undefined);
    const text = defaultAnswer(prompt, contract, filler);
    return { kind: 'text', text: wrapped(text ?? 'OK', contract) };
  };
}
