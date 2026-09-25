/**
 * tc-writer — test criteria for every story the request lists, one entry per story id.
 *
 * The stories and their implementation files are read from the request's own list (the objects
 * carrying a story id); facts come from each story's acceptance criteria in the PRD, so they are
 * checkable statements about THIS story. Each entry's shape is the prompt's own exemplar entry:
 * fields the exemplar shows and this module does not know are kept as the exemplar fills them.
 */
import { jsonValues, fill } from '../answer';
import type { Contract } from '../declarations';
import type { World } from '../world';

export function testCriteria(world: World, prompt: string, contract?: Contract): string {
  const listed = (jsonValues(prompt).find((v) => Array.isArray(v) && v.some((x: any) => x && x.storyId)) as any[] | undefined) || [];
  // The exemplar ENTRY: the object keyed by a story-id placeholder, whose value carries the contract's keys.
  const req = contract?.requiredKeys || [];
  const keyed = jsonValues(prompt).find((v: any) => v && !Array.isArray(v) && Object.keys(v).length === 1 && /story/i.test(Object.keys(v)[0])
    && req.every((k) => k in (Object.values(v)[0] as object || {}))) as Record<string, unknown> | undefined;
  const entryShape = (keyed ? Object.values(keyed)[0] : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const item of listed) {
    const story = world.story(item.storyId);
    const acs = (story?.acceptanceCriteria || []).map((a: any) => (typeof a === 'string' ? a : a?.text || a?.description || JSON.stringify(a)));
    const base = fill(entryShape, (_k, o) => o[0]) as Record<string, unknown>;
    out[item.storyId] = {
      ...base,
      verifiedAt: new Date().toISOString(),
      sourceFiles: (item.implSourceFiles || []).filter((f: string) => !/\/$/.test(f)),
      facts: acs.length ? acs : [`${item.storyId} delivers the files it declares`],
      mockStrategy: `Use this repository's existing test setup for ${item.testFile || 'the story test'}; mock only what crosses the process boundary.`,
      bannedPatterns: [],
      ...(contract?.requiredKeys || []).filter((k) => !(k in base)).reduce((o, k) => ({ ...o, [k]: [] }), {}),
    };
  }
  return JSON.stringify(out);
}
