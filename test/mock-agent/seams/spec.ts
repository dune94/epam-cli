/**
 * story-specification — the spec agent's verification criteria, derived from the story it is given.
 *
 * Brownfield's contract demands at least one verificationCriteriaDetail entry {criterion, observer,
 * surface}: with acceptance criteria out of scope, the verification criteria ARE the spec. The stand-in
 * answered [] (the neutral default for an array), so every story reached the writer with no criteria
 * and every step that judges against them — Step 3.545 among them — skipped it (£0 multi-lane run,
 * 2026-10-04). A diligent model states each acceptance criterion as an observable check; so does this.
 *
 * Nothing about any stack: the criteria are the story's own, the observer is the first value the
 * contract's enum allows that names a person who runs a test, the surface is where a test is read.
 */
import type { Call } from '../agent';
import type { World } from '../world';
import type { Field } from '../rendered-schema';
import type { Filler } from '../answer';

const textOf = (a: unknown) => (typeof a === 'string' ? a : (a as any)?.text || (a as any)?.description || '');

/** The story's acceptance criteria: from the world, else the "Acceptance criteria" list in the prompt. */
function criteriaFor(world: World, prompt: string, call: Call): string[] {
  const story = world.story(call.story) as { acceptanceCriteria?: unknown[] } | undefined;
  const fromStory = (story?.acceptanceCriteria || []).map(textOf).map((s) => String(s).trim()).filter(Boolean);
  if (fromStory.length) return fromStory;
  const m = /Acceptance criteria:\s*\n((?:\s*[-*]\s+.+\n?)+)/i.exec(prompt);
  return m ? m[1].split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean) : [];
}

export function storySpecification(world: World, prompt: string, _fields: Field[], call: Call): Filler {
  return (f) => {
    if (f.name !== 'verificationCriteriaDetail') return undefined;
    const criteria = criteriaFor(world, prompt, call);
    if (!criteria.length) return undefined;
    const nested = [...(f.items || []), ...(f.fields || []), ...(f.items || []).flatMap((i) => i.fields || [])];
    const observers = nested.find((x) => x.name === 'observer')?.enum || [];
    const observer = observers.find((o) => /tester/i.test(o)) || observers[0] || 'tester';
    return criteria.map((criterion) => ({ criterion, observer, surface: 'the result of running the codeline\'s tests' }));
  };
}

/**
 * guard-vocabulary — the terms that would make a criterion describe the implementation, and the terms
 * of its observable surface, derived from the code evidence and the story the prompt carries. The
 * stand-in answered empty lists; the engine refuses a guard with no vocabulary ("a guard with no
 * vocabulary checks nothing"), which no run ever reached while the spec answered no criteria.
 */
export function guardVocabulary(prompt: string): Filler {
  const code = [...prompt.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  const identifiers = [...new Set((code || prompt).match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g) || [])].slice(0, 12);
  const literals = [...new Set([...prompt.matchAll(/'([^'\n]{3,60})'/g)].map((m) => m[1]))].slice(0, 8);
  return (f) => {
    if (f.name === 'blacklist') {
      return identifiers.map((t) => ({ term: t.toLowerCase(), reason: 'names the implementation, not what is observed', kind: 'implementation_noun' }));
    }
    if (f.name === 'whitelist') return literals.map((t) => ({ term: t.toLowerCase(), reason: 'what the user observes' }));
    return undefined;
  };
}
