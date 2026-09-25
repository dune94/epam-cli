/**
 * agent-mint — proposes the project's roles as the prompt's rules require.
 *
 * One implementer spanning the project (codeline "*"), named for the project's domain with the
 * implementer suffix; one investigator per codeline in scope, naming that codeline. Suffixes and the
 * wildcard are read from the rendered contract's own notes, not written here.
 */
import type { Filler } from '../answer';
import type { World } from '../world';
import type { Field } from '../rendered-schema';

/** The first suffix a note offers for a kind, e.g. `implementer: -engineer or -fixer` → "-engineer". */
const suffixFor = (note: string, kind: string) => (new RegExp(`${kind}:\\s*(-[a-z]+)`).exec(note) || [])[1] || '';

export function agentMint(world: World, prompt: string, fields: Field[]): Filler {
  const agentsField = fields.find((x) => x.type === 'array');
  const nameNote = agentsField?.items?.find((x) => x.name === 'name')?.note || '';
  const kindField = agentsField?.items?.find((x) => x.name === 'kind');
  const [implKind, invKind] = kindField?.enum || ['implementer', 'investigator'];
  const wildcard = (/use\s+"([^"]+)"/.exec(agentsField?.items?.find((x) => x.name === 'codeline')?.note || '') || [])[1] || '*';
  const domain = world.domain();
  const stack = world.stories().flatMap((s) => s.technicalNotes?.files || []).slice(0, 6).join(', ');
  return (f, path) => {
    if (!agentsField || path !== agentsField.name) return undefined;
    const impl = {
      name: `${domain}${suffixFor(nameNote, implKind)}`,
      kind: implKind,
      codeline: wildcard,
      systemPrompt: `You implement the ${domain} stories. You own the files each story declares (${stack || 'as the stories name them'}), write their tests alongside the code, and follow the conventions already present in the repository.`,
      rationale: `The ${domain} stories declare implementation files and tests that one implementer must write end to end.`,
    };
    const invs = world.codelinesIn(prompt).map((c) => ({
      name: `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${suffixFor(nameNote, invKind)}`,
      kind: invKind,
      codeline: c.name,
      systemPrompt: `You read ${c.name} and report where the modules relevant to each story live, the layout and naming conventions, and which declared dependencies matter.`,
      rationale: `${c.name} is the codeline the ${domain} stories build, so it needs a reader who knows its layout.`,
    }));
    return [impl, ...invs];
  };
}
