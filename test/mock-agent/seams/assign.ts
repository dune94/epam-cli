/**
 * role-assigner — every story the request names gets a role the request offers.
 *
 * Each entry is built from the rendered contract's own item schema, so a field renamed or added in
 * the code is followed, not guessed: only a story id, a codeline and a role are supplied here, and
 * every other field is prose from the story. The roles offered are the roster's agents the prompt
 * lists; with one implementer, that one owns every story.
 */
import { build, type Field } from '../rendered-schema';
import type { Filler } from '../answer';
import type { World } from '../world';

export function roleAssigner(world: World, prompt: string, fields: Field[]): Filler {
  const roles = world.offered(prompt, world.rosterAgents());
  const codeline = world.codelinesIn(prompt)[0]?.name;
  const list = fields.find((f) => f.type === 'array' && f.items);
  return (f, path) => {
    if (!list || path !== list.name) return undefined;
    // THE UNIT IS A (STORY, CODELINE) PAIR: the codelines the prompt lists under each story, by the
    // identifiers the run gave them; a prompt that lists none (one output directory) takes the world's.
    return world.storiesIn(prompt).flatMap((s) => {
      const role = roles.find((r) => s.agentRole === r) || roles[0];
      const block = prompt.slice(Math.max(0, prompt.indexOf(`- ${s.id}:`))).split(/\n- /)[0];
      const listed = (/\n\s+codelines?:\s*([^\n]+)/.exec(block) || [, ''])[1].split(/[,\s]+/).filter(Boolean);
      return (listed.length ? listed : [codeline]).map((cl) => build(list.items!, (item) => {
        if (/story/i.test(item.name)) return s.id;
        if (/codeline/i.test(item.name)) return cl;
        if (/role|agent/i.test(item.name)) return role;
        if (item.type === 'string') return `${role} authors the files ${s.id} declares${(s.technicalNotes?.files || []).length ? ` (${(s.technicalNotes!.files || []).slice(0, 2).join(', ')})` : ''}.`;
        return undefined;
      }));
    });
  };
}
