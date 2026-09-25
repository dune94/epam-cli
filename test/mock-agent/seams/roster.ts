/**
 * roster-specialiser — specialises canonical personas for this project, as the prompt asks.
 *
 * It lists the canonical roster directory the prompt names (one persona per `<name>.txt`), keeps
 * each chosen persona's role and adds what this project's codelines and stack are. Ancestry is the
 * agent itself; kind and seam are optional and a specialised agent keeps its canonical ones, so they
 * are left out. The minted agents are the project's own and are not re-specialised here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathsIn } from '../answer';
import type { World } from '../world';

/** The personas a model would specialise: the canonical agents whose persona names an implementing or reviewing role. */
export function rosterDelta(world: World, prompt: string, max = 3): Record<string, unknown> {
  const dir = pathsIn(prompt).find((p) => { try { return statSync(p).isDirectory() && readdirSync(p).some((f) => f.endsWith('.txt')); } catch { return false; } });
  const agents: Record<string, unknown> = {};
  if (!dir) return { agents };
  const codelines = world.codelinesIn(prompt).map((c) => c.name).join(', ');
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  for (const f of files.slice(0, max)) {
    const name = basename(f, '.txt');
    const generic = readFileSync(join(dir, f), 'utf8').trim();
    agents[name] = {
      persona: `${generic}\n\nOn this project you work in ${codelines}. Follow the layout and conventions the codeline already has and the files each story declares.`,
      ancestor: name,
      rationale: `The ${world.domain()} stories exercise ${name}, so its persona must know the codeline it works in.`,
    };
  }
  return { agents };
}
