/**
 * A JUDGE THAT FINDS NOTHING WRONG — the correct answer of every reviewing seam on sound work.
 *
 * Which seams judge is the registry's own declaration (what a seam `produces`: a verdict, review
 * feedback, findings), never a list here. On sound work a judge lists no findings and gives its
 * passing verdict; which value is passing is read from the verdict field's own definitions in the
 * rendered contract ("sound = every checkable claim held. defects_found = …").
 */
import type { Filler } from '../answer';
import type { Field } from '../rendered-schema';

export const judges = (produces: string | undefined) => /verdict|review|findings/i.test(produces || '');

const NEGATIVE = /defect|fail|reject|block|not |missing|wrong|invalid|unsound|incomplete|revis|change/i;

/** The enum value a field's own note defines as the clean outcome; the first value if none is defined. */
export function passingValue(f: Field): string | undefined {
  if (!f.enum?.length) return undefined;
  const defined = f.enum.map((v) => ({ v, def: (new RegExp(`\\b${v}\\s*=\\s*([^.]*)`).exec(f.note) || [])[1] }));
  const clean = defined.find((d) => d.def !== undefined && !NEGATIVE.test(d.def) && !NEGATIVE.test(d.v));
  return (clean || defined.find((d) => !NEGATIVE.test(d.v)) || defined[0]).v;
}

export function judgeFindsNothing(): Filler {
  return (f) => {
    if (f.type === 'array') return [];
    if (f.enum?.length) return passingValue(f);
    return undefined;
  };
}
