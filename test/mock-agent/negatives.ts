/**
 * THE WAYS A MODEL REALLY GOES WRONG — applied to the answer the agent would otherwise give.
 *
 * Each negative takes the CORRECT answer for the call (so it stays about this seam, this story,
 * this codeline) and breaks it the way live runs have: prose instead of the format, nothing at all,
 * cut off at the output cap, wrapped in fences, a required field dropped, a value outside the enum,
 * a vendor error, a hang. The turn is labelled negative, so the agent serves it deliberately and the
 * reconciliation that guards correct answers does not refuse it.
 */
import type { Behaviour, Call } from './agent';
import { negative } from './agent';
import { jsonValues } from './answer';
import type { Turn } from './wire';

export type NegativeName = 'prose' | 'empty' | 'truncated' | 'fenced' | 'drop-required' | 'bad-enum' | 'http-500' | 'http-429' | 'hang';

const textOf = (t: Turn) => (t.kind === 'text' ? t.text : '');

export const NEGATIVES: Record<NegativeName, (correct: Turn, call: Call) => Turn> = {
  prose: (_c, call) => negative({ kind: 'text', text: `I looked at ${call.story || 'the work'} carefully and it all seems reasonable to me. Nothing stands out.` }, 'prose instead of the stated format'),
  empty: () => negative({ kind: 'text', text: '' }, 'an empty answer'),
  truncated: (c) => negative({ kind: 'text', text: textOf(c).slice(0, Math.max(1, Math.floor(textOf(c).length / 2))), stop: 'max_tokens' }, 'cut off at the output cap'),
  fenced: (c) => negative({ kind: 'text', text: `\`\`\`json\n${textOf(c)}\n\`\`\`` }, 'wrapped in markdown fences'),
  'drop-required': (c) => {
    const t = textOf(c); const v = jsonValues(t).find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
    const k = v && Object.keys(v)[0];
    return negative({ kind: 'text', text: k ? t.replace(JSON.stringify(v, null, 2), JSON.stringify({ ...v, [k]: undefined }, null, 2)).replace(JSON.stringify(v), JSON.stringify({ ...v, [k]: undefined })) : t }, `the first field (${k}) dropped`);
  },
  'bad-enum': (c) => negative({ kind: 'text', text: textOf(c).replace(/"(verdict|target|state|kind|severity)"\s*:\s*"[^"]*"/, '"$1": "definitely_not_a_declared_value"') }, 'a value outside the declared enum'),
  'http-500': () => negative({ kind: 'http-error', status: 500, body: '{"error":{"message":"upstream provider error"}}' }, 'vendor 500'),
  'http-429': () => negative({ kind: 'http-error', status: 429, body: '{"error":{"message":"rate limited"}}' }, 'vendor 429'),
  hang: () => negative({ kind: 'hang' }, 'the call never answers'),
};

/**
 * A scenario: for the seams that produce something (optionally a story, attempts, every n-th call), which negative to apply.
 * Everything not named answers correctly.
 */
/** Which seam a rule breaks: by what it PRODUCES (the registry's declaration), never by its name. */
export type Rule = { produces: string; story?: string; attempts?: number[]; negative: NegativeName;
  /** Break only every n-th call to the seam (1-based: calls k, k+n, …) — so a retry can recover. */
  every?: { n: number; k: number } };

export function withScenario(correct: Behaviour, rules: Rule[]): Behaviour {
  const seen = new Map<string, number>();
  return (call, agent) => {
    const good = correct(call, agent);
    const nth = (seen.get(call.seam) || 0) + 1; seen.set(call.seam, nth);
    const produces = agent.decl.registry[call.seam]?.produces || '';
    const rule = rules.find((r) => r.produces === produces && (!r.story || r.story === call.story) && (!r.attempts || r.attempts.includes(call.attempt))
      && (!r.every || nth % r.every.n === r.every.k % r.every.n));
    return rule && good ? NEGATIVES[rule.negative](good, call) : good;
  };
}
