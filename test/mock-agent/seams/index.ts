/**
 * EVERY SEAM'S CORRECT BEHAVIOUR, IN ONE PLACE.
 *
 * A seam with its own module answers with the values a diligent model would give, drawn from the
 * request and the world; every other seam answers in the format its prompt renders, with neutral
 * values. Adding a seam's realism is adding one entry here — the format, the contract and the
 * reconciliation are shared and read from the code at call time.
 */
import type { Behaviour, Call } from '../agent';
import { defaultAnswer, renderedFor, exemplar, type Filler } from '../answer';
import { withExampleEnums, type Field } from '../rendered-schema';
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
import { perStoryList } from './per-story';

type FillerFor = (world: World, prompt: string, fields: Field[], call: Call) => Filler;

/**
 * Every map below is keyed by what a seam PRODUCES (the registry's declaration), never by a seam's
 * name — the repository's rule for naming a seam in a test. A renamed seam keeps its behaviour.
 */
/** Seams whose values need knowledge of the world. The rest take the neutral default. */
export const FILLERS: Record<string, FillerFor> = {
  'estate-survey': (w, p) => estateSurvey(w, p),
  'agent-roster': (w, p, f) => agentMint(w, p, f),
  'role-assignments': (w, p, f) => roleAssigner(w, p, f),
};

/** Seams whose whole answer is built from the world rather than from a rendered schema. */
export const WHOLE: Record<string, (world: World, prompt: string, call: Call, contract?: Contract) => string> = {
  'test-criteria': (w, p, _c, k) => testCriteria(w, p, k),
  'project-roster': (w, p) => JSON.stringify(rosterDelta(w, p)),
  'project-prompts': (w, p) => segmented(w, p) ?? 'OK',
};

/** A contract that declares a tag is answered inside it, whatever style the prompt rendered its shape in. */
export const wrapped = (text: string, contract?: Contract) => (contract?.tag && !text.includes(`<${contract.tag}>`) ? `<${contract.tag}>\n${text}\n</${contract.tag}>` : text);

export const promptOf = (call: Call) => `${call.req.system}\n${call.req.messages.find((m) => m.role === 'user')?.text || ''}`;

/**
 * Answers keyed by TEMPLATE, for a seam reached through several templates with different formats
 * (impl-failure-analyst answers a failure diagnosis, a phase assessment and a gate finding).
 */
export const DIAGNOSING: Record<string, (world: World, prompt: string, call: Call, contract?: Contract) => string> = {
  diagnosis: (w, p, c, k) => failureAnalyst(w, p, c.story, k),
};

/** Seams that ACT through tools, turn by turn, rather than answer in one reply. */
export const ACTING: Record<string, (world: World, install: string) => Behaviour> = {
  implementation: (w, i) => writerDelivers(w, i),
};

/** The behaviour of a model that does each seam's job correctly. */
export function correct(world: World, install: string): Behaviour {
  const acting = Object.fromEntries(Object.entries(ACTING).map(([k, f]) => [k, f(world, install)]));
  return (call, agent) => {
    const produces = agent.decl.registry[call.seam]?.produces || '';
    if (acting[produces]) return acting[produces](call, agent);
    const prompt = promptOf(call);
    const contract = agent.decl.contractOf(call.seam);
    // A seam reached through several templates: the diagnosis behaviour answers only the prompt
    // that asks for the contract's required keys; the seam's other prompts take the default.
    const asksContract = (contract?.requiredKeys || []).every((k) => prompt.includes(`"${k}"`));
    if (DIAGNOSING[produces] && asksContract) return { kind: 'text', text: wrapped(DIAGNOSING[produces](world, prompt, call, contract), contract) };
    if (WHOLE[produces]) return { kind: 'text', text: wrapped(WHOLE[produces](world, prompt, call, contract), contract) };
    const tplText = agent.decl.templateText(call.template);
    const fields = withExampleEnums(renderedFor(prompt, contract)?.fields || [], exemplar(tplText.replace(/__[A-Z][A-Z0-9_]*__/g, ''), undefined));
    // Each field takes the first filler that knows it: the seam's own, a per-story list, a judge's
    // clean verdict, then the story's own value for a field the story carries (its title is its
    // title — a placeholder there reached the PRD).
    const story = world.story(call.story) as Record<string, unknown> | undefined;
    // Only into an answer SHAPED LIKE A STORY (at least three fields in common with the story), and
    // never into a field with declared values — a KB constraint shares `id` and `status` with a
    // story and took the story's "pending" status and its id.
    const storyShaped = !!story && fields.filter((f) => f.name in story).length >= 3;
    const fromStory: Filler = (f) => (storyShaped && !f.enum?.length && f.type !== 'array' && f.type !== 'object' && typeof story![f.name] === 'string' ? story![f.name] : undefined);
    const chain = [FILLERS[produces]?.(world, prompt, fields, call), perStoryList(world, prompt, fields, tplText),
      judges(produces) ? judgeFindsNothing() : undefined, fromStory].filter(Boolean) as Filler[];
    const filler: Filler = (f, path) => { for (const c of chain) { const v = c(f, path); if (v !== undefined) return v; } return undefined; };
    const text = defaultAnswer(prompt, contract, filler, tplText);
    return { kind: 'text', text: wrapped(text ?? 'OK', contract) };
  };
}
