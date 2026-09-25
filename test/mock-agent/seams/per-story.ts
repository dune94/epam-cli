/**
 * A LIST WHOSE ITEMS ARE ABOUT STORIES — one item for every story the prompt lists.
 *
 * Whenever a seam's rendered contract answers with a list and the item schema carries a story id,
 * a diligent model answers every story it was shown, not none. Each item is built from the item
 * schema itself (so a renamed or added field is followed): the story id, the judge's passing value
 * for any enum, a score at the top of a declared 0–1 range, prose for the rest.
 */
import { build, type Field } from '../rendered-schema';
import { jsonValues, type Filler } from '../answer';
import { passingValue } from './judge';
import type { World } from '../world';

/** A literal the template's example gives (not a <placeholder>, not an a|b choice): what a model copies. */
const literal = (v: unknown): boolean => (typeof v === 'string' ? !/[<|]/.test(v) && v.trim() !== '' && v !== '...'
  : Array.isArray(v) ? v.length > 0 && v.every(literal) : typeof v === 'number' || typeof v === 'boolean');

export function perStoryList(world: World, prompt: string, fields: Field[], templateText = ''): Filler | undefined {
  const list = fields.find((f) => f.type === 'array' && f.items?.some((i) => /story/i.test(i.name)));
  if (!list) return undefined;
  // The template's own example ITEM: the object it shows carrying the list's story field.
  const storyField = list.items!.find((i) => /story/i.test(i.name))!.name;
  const example = (jsonValues(templateText.replace(/__[A-Z][A-Z0-9_]*__/g, '')).flatMap((v) => (Array.isArray(v) ? v : [v, ...Object.values((v as object) || {}).flat()]))
    .find((o: any) => o && typeof o === 'object' && !Array.isArray(o) && storyField in o) || {}) as Record<string, unknown>;
  const stories = world.storiesIn(prompt);
  return (f, path) => {
    if (path !== list.name) return undefined;
    return stories.map((s) => build(list.items!, (item) => {
      if (/story/i.test(item.name)) return s.id;
      if (literal(example[item.name])) return example[item.name];
      if (item.enum?.length) return passingValue(item);
      if (item.type === 'number') return /score|confidence/i.test(item.name) ? 0.9 : 1;
      if (item.type === 'array') return [];
      return undefined;
    }));
  };
}
