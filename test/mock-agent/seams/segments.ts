/**
 * A SEGMENTED ANSWER — the reply format a builder prompt states: the markers it shows, in order,
 * each followed by that segment's wording, then its closing marker.
 *
 * Markers and segments are read from the request (whatever the markers are called there); each
 * segment is answered with its own wording plus a line naming the project, so every rule the
 * generic segment states survives, as the prompt demands. An empty segment stays empty.
 */
import type { World } from '../world';

const MARKER = /^---\s*([A-Z][A-Z ]*?)\s*(\d+)?\s*---\s*$/;

export function segmented(world: World, prompt: string): string | null {
  const lines = prompt.split('\n');
  const marks = lines.map((l, i) => ({ i, m: MARKER.exec(l.trim()) })).filter((x) => x.m);
  const numbered = marks.filter((x) => x.m![2]);
  if (!numbered.length) return null;
  const label = numbered[0].m![1];
  const end = marks.find((x) => !x.m![2] && x.i > numbered[numbered.length - 1].i);
  const out: string[] = [];
  numbered.forEach((mk, k) => {
    const stop = k + 1 < numbered.length ? numbered[k + 1].i : (end ? end.i : lines.length);
    const body = lines.slice(mk.i + 1, stop).join('\n').trim();
    out.push(`--- ${label} ${mk.m![2]} ---`);
    out.push(body ? `${body}${/[.!?]$/.test(body) && body.length > 80 ? `\n(On ${world.domain()}: apply this to the codeline's own layout and conventions.)` : ''}` : '');
  });
  if (end) out.push(lines[end.i].trim());
  return out.join('\n');
}
