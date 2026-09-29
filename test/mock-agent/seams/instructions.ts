/**
 * si-author — a seam's standing instructions, built from what the request hands the author: the seam's
 * declaration, the agent's persona and the seam's own task prompt, each read through the author
 * template's own slots (Declarations.slot). Every entry is taken from those inputs, as a model that
 * reads them would take it; nothing about any seam is known here.
 */
import type { Filler } from '../answer';
import type { Call, MockAgent } from '../agent';

const sentences = (t: string) => (t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]/g) || []).map((s) => s.trim()).filter(Boolean);
const SLOT = /__[A-Z][A-Z0-9_]*__/;
const LISTED = /^(\d+[.)]|[-*•])\s+/;
const SHAPE = /[{}]|"[A-Za-z_][\w-]*"\s*:/;

export function standingInstructions(prompt: string, call: Call, agent: MockAgent): Filler {
  const slot = (p: string) => agent.decl.slot(call.template, p, prompt);
  let decl: Record<string, any> = {};
  try { decl = JSON.parse(slot('__TARGET_DECLARATION__')); } catch { decl = {}; }
  const persona = slot('__TARGET_PERSONA__');
  const task = slot('__TARGET_TEMPLATE__');
  // The output structure is the task prompt's to state, and the author is told not to restate it:
  // a line that spells out a JSON shape is left where it is.
  const lines = task.split('\n').map((l) => l.trim()).filter((l) => l && !SLOT.test(l) && !SHAPE.test(l));
  const rules = lines.filter((l) => /\b(must|never|only|always|every)\b/i.test(l)).slice(0, 5);
  const steps = lines.filter((l) => LISTED.test(l)).map((l) => l.replace(LISTED, '')).slice(0, 5);
  const said = sentences(persona);
  const purpose = String(decl.purpose || '').trim();
  const tools: string[] = Array.isArray(decl.tools) ? decl.tools : [];
  const orElse = (a: string[], b: string[]) => (a.length ? a : b.length ? b : [purpose].filter(Boolean));
  const values: Record<string, unknown> = {
    role_and_purpose: [said.slice(0, 2).join(' '), purpose].filter(Boolean).join(' '),
    judgement_framework: orElse(rules, said.slice(2, 5)),
    duties: orElse(steps, rules.slice(0, 3)),
    constraints: [
      tools.length ? `Use only these tools: ${tools.join(', ')}.` : 'You have no tools: work only from what the task gives you.',
      ...(decl.produces ? [`Produce only ${decl.produces}; the rest of the pipeline belongs to other seams.`] : []),
    ],
    output_protocol: 'Answer in exactly the structure the task prompt specifies, and nothing else.',
  };
  return (f) => (f.name in values ? values[f.name] : undefined);
}
