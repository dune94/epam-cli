/**
 * AN ANSWER BUILT FROM THE REQUEST — the way a model builds one.
 *
 * A model reads the prompt, including the answer format the prompt states, and answers in that
 * format about the things the prompt names. So does this: the format is the exemplar the prompt
 * itself carries (every seam prompt shows its answer), checked against the seam's declared
 * contract; the values are taken from the request's own content. Nothing is recorded, nothing is
 * listed per project — the same agent answers any codeline, and follows any prompt change.
 */
import type { Contract } from './declarations';
import { renderedSchemas, build, violations, jsonSchemaFields, type Field } from './rendered-schema';

/**
 * JSON, or the placeholder-style JSON prompts write to show a shape: bare `N` / identifiers where a
 * value goes, `...` for "more of the same". Read as a model reads it — N a number, the rest text.
 */
export function parseLoose(t: string): unknown {
  try { return JSON.parse(t); } catch { /* try the shape notation */ }
  const shaped = t
    .replace(/\[\s*\.\.\.\s*\]/g, '[]')
    .replace(/,\s*\.\.\.\s*([\]}])/g, '$1')
    .replace(/:\s*\.\.\.\s*([,}\]])/g, ': "..."$1')
    .replace(/:\s*N\b/g, ': 0')
    .replace(/:\s*<[^"<>]*>/g, ': 0')
    .replace(/:\s*(?!true\b|false\b|null\b)([A-Za-z_][\w-]*)\s*([,}\]])/g, ': "$1"$2')
    .replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(shaped); } catch { return undefined; }
}

/** Every balanced {...} or [...] in a text that parses as JSON (or shape notation), in order of appearance. */
export function jsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0; let inStr = false; let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth += 1;
      else if (ch === close) { depth -= 1; if (depth === 0) { const v = parseLoose(text.slice(i, j + 1)); if (v !== undefined) { out.push(v); i = j; } break; } }
    }
  }
  return out;
}

const keysOf = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : []);

/** The exemplar the prompt states for this answer: the JSON object carrying most of the required keys. */
export function exemplar(prompt: string, contract?: Contract, templateText = ''): Record<string, unknown> | null {
  // THE PROMPT AS SENT IS WHAT A MODEL ANSWERS. A resumed run keeps the project prompts it built,
  // so the rendered prompt can differ from the template on disk — a model follows the prompt.
  // The template only tells a FORMAT apart from INPUT (evidence, stories, earlier answers, much of
  // it JSON): among the prompt's own examples, the one shaped like the template's example wins.
  const fromPrompt = exemplarIn(prompt, contract);
  if (!templateText) return fromPrompt;
  const own = exemplarIn(templateText.replace(/__[A-Z][A-Z0-9_]*__/g, ''), contract);
  if (!own) return fromPrompt;
  const shape = (v: unknown) => keysOf(v).sort().join(',');
  const same = jsonValues(prompt).filter((v) => shape(v) === shape(own)) as Record<string, unknown>[];
  if (!same.length) return fromPrompt;
  // Several of that shape ("{pass…} OR {fail…}"): the clean one, as exemplarIn chooses.
  return exemplarIn(same.map((v) => JSON.stringify(v)).join('\n'), contract) || same[0];
}

function exemplarIn(prompt: string, contract?: Contract): Record<string, unknown> | null {
  const req = contract?.requiredKeys || [];
  const known = new Set([...(contract?.knownKeys || []), ...req]);
  const scored: { v: Record<string, unknown>; score: number; at: number }[] = [];
  jsonValues(prompt).forEach((v, at) => {
    const k = keysOf(v); if (!k.length) return;
    // With no declared keys, every object shown is a candidate format.
    const score = req.length || known.size ? req.filter((r) => k.includes(r)).length * 10 + k.filter((x) => known.has(x)).length : 1;
    if (score > 0) scored.push({ v: v as Record<string, unknown>, score, at });
  });
  // No shown object carries the contract's keys: the prompt's own LAST stated format is what a model
  // follows (the disagreement with the contract is reported as a conflict, not papered over).
  if (!scored.length) {
    const last = jsonValues(prompt).filter((v) => keysOf(v).length).pop();
    return (last as Record<string, unknown>) || null;
  }
  const top = Math.max(...scored.map((c) => c.score));
  // Among formats that fit equally, a prompt often shows ALTERNATIVES ("{pass…} OR {fail…}"). The
  // answer a model gives on sound work is the CLEAN one — no findings listed — so that wins; then
  // the last shown, since answer formats come after a prompt's input.
  const filled = (v: Record<string, unknown>) => Object.values(v).filter((x) => Array.isArray(x) && x.length > 0).length;
  const shapeOf = (v: Record<string, unknown>) => Object.keys(v).sort().join(',');
  const best = scored.filter((c) => c.score === top);
  const lastShape = shapeOf(best[best.length - 1].v);
  const alternatives = best.filter((c) => shapeOf(c.v) === lastShape);
  alternatives.sort((a, b) => (filled(a.v) - filled(b.v)) || (b.at - a.at));
  return alternatives[0].v;
}

/**
 * Fill an exemplar the way a model does: an enum written `a|b|c` becomes one of its values (the
 * scenario may choose which), a `<describe it>` hole becomes prose, a list keeps one filled entry.
 */
const OMIT = Symbol('omit');

export function fill(v: unknown, choose: (key: string, options: string[]) => string, key = ''): unknown {
  const out = fillOrOmit(v, choose, key);
  return out === OMIT ? undefined : out;
}

function fillOrOmit(v: unknown, choose: (key: string, options: string[]) => string, key: string): unknown {
  if (typeof v === 'string') {
    // `a|b|c (optional — …)`: an optional field a model usually leaves out.
    if (/\(optional\b/i.test(v)) return OMIT;
    const bare = v.replace(/\s*\(.*\)\s*$/, '').trim();
    const opts = bare.split('|').map((s) => s.trim());
    if (opts.length > 1 && opts.every((o) => /^[A-Za-z_][\w:-]*$/.test(o))) return choose(key, opts);
    if (/^<.*>$/.test(bare) || bare === '...') return `${key || 'value'} derived from the request`;
    return v;
  }
  // A list shown in an exemplar is its SHAPE, not content: empty unless a seam's filler supplies entries.
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const y = fillOrOmit(x, choose, k); if (y !== OMIT) o[k] = y; }
    return o;
  }
  return v;
}

/** Existing filesystem paths a prompt names — what a model would list or open with its tools. */
export function pathsIn(prompt: string): string[] {
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  return [...new Set([...prompt.matchAll(/(\/[\w.@+-]+(?:\/[\w.@+-]+)+)/g)].map((m) => m[1]))].filter((p) => existsSync(p));
}

/** The ids of stories a request names (STORY: X, "storyId": "X", …), in order of appearance. */
export function storyIds(text: string, known: string[]): string[] {
  return known.filter((id) => new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`).test(text));
}

/**
 * RECONCILE AN ANSWER WITH THE CODE AS IT IS NOW — before it is served.
 *
 * A mock the current code cannot accommodate is worse than none: it fails the run for the mock's
 * reason and hides the pipeline's. So an answer the agent means as CORRECT is checked against the
 * seam's current declared contract; any mismatch is reported as a STALE MOCK and never served.
 * Returns the reasons it does not fit (empty = fits).
 */
export function reconcile(text: string, contract: Contract | undefined, prompt: string, templateText = ''): string[] {
  // THE FORMAT THE PROMPT STATES is what the current code asks of the model on this call.
  const rendered = renderedFor(prompt, contract);
  if (rendered && !rendered.tag) {
    const v = jsonValues(text).find((x) => x && typeof x === 'object');
    return v === undefined ? ['no JSON answer, but the prompt carries a JSON Schema'] : violations(rendered.fields, v);
  }
  if (rendered) {
    const m = new RegExp(`<${rendered.tag}>\\s*([\\s\\S]*?)\\s*</${rendered.tag}>`).exec(text);
    if (!m) return [`no <${rendered.tag}> block, but the prompt's contract demands one`];
    const v = jsonValues(m[1])[0];
    return v === undefined ? [`the <${rendered.tag}> block holds no JSON`] : violations(rendered.fields, v);
  }
  // A seam whose declared answer is not JSON (it writes an artefact, or declares nothing) is not
  // held to a JSON example that happens to appear in its prompt — builders embed other templates.
  const jsonKinds = ['declared', 'schema', 'verdict', 'per-story-map'];
  const ex = contract && jsonKinds.includes(contract.kind) ? exemplar(prompt, contract, templateText) : null;
  if (ex) {
    const v = jsonValues(text).find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
    if (!v) return ['no JSON answer, but the prompt shows one'];
    // A key the prompt says may be left out ("(optional", "omit …") is not wanted of every answer.
    // Judged on the PROMPT'S OWN TEXT for the key, not the parsed value — shape notation like
    // `<raise ONLY if … omit otherwise>` parses to a number and loses the word that says so.
    const saysOptional = (k: string) => new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:[^\\n]{0,600}?(\\(optional\\b|\\bomit\\b)`, 'i').test(prompt);
    // …or a rule that includes the key only in some case ("Only include tool_spec when target=tool").
    const conditional = (k: string) => new RegExp(`only include[^\\n.]*\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\n.]*\\bwhen\\b`, 'i').test(prompt);
    const wanted = Object.entries(ex).filter(([k, x]) => !/\(optional\b|\bomit\b/i.test(JSON.stringify(x)) && !saysOptional(k) && !conditional(k)).map(([k]) => k);
    return contract?.kind === 'per-story-map' ? [] : wanted.filter((k) => !(k in v)).map((k) => `key '${k}' the prompt shows is missing`);
  }
  if (contract && jsonKinds.includes(contract.kind) && contract.kind !== 'verdict'
      && !jsonValues(text).some((x) => x && typeof x === 'object')) return [`no JSON answer, but the ${contract.kind} contract expects one`];
  return [];
}

/**
 * WHERE THE PROMPT AND THE SEAM'S DECLARED CONTRACT DISAGREE — a pipeline finding, not a mock fault:
 * a model that follows the prompt gives an answer the contract rejects (or the reverse).
 */
export function contractConflict(prompt: string, contract: Contract | undefined, templateText = ''): string[] {
  if (!contract) return [];
  const rendered = renderedFor(prompt, contract);
  const shown = rendered ? rendered.fields.map((f) => f.name) : Object.keys(exemplar(prompt, contract, templateText) || {});
  const out: string[] = [];
  // A sub-prompt that renders its OWN tagged block is validated by that tag at its call site, not
  // by the seam's main tag — only a prompt that asks for no block at all disagrees with the contract.
  if (contract.tag && !prompt.includes(`<${contract.tag}>`) && !renderedSchemas(prompt).length) out.push(`the contract requires a <${contract.tag}> block the prompt never asks for`);
  if (shown.length && contract.kind !== 'per-story-map') {
    const missing = (contract.requiredKeys || []).filter((k) => !shown.includes(k));
    if (missing.length) out.push(`the prompt asks for {${shown.join(', ')}} but the contract requires ${missing.join(', ')}`);
    // Keys the prompt tells a model to send that the contract does not know: its consumer's view of
    // the answer is older (or newer) than the prompt's.
    if (contract.knownKeys) {
      const unknown = shown.filter((k) => !contract.knownKeys!.includes(k));
      if (unknown.length) out.push(`the prompt asks for ${unknown.join(', ')}, which the contract's knownKeys do not list`);
    }
  }
  return out;
}

/** The rendered contract for this call: the seam's own tag if the prompt renders it, else the last block rendered. */
export function renderedFor(prompt: string, contract?: Contract): { tag: string; fields: Field[] } | undefined {
  const all = renderedSchemas(prompt);
  const tagged = all.find((r) => contract?.tag && r.tag === contract.tag) || all[all.length - 1];
  if (tagged) return tagged;
  // A JSON Schema the prompt carries: the last object shaped like one. Untagged — answered as bare JSON.
  const schema = jsonValues(prompt).filter((v: any) => v && v.type === 'object' && v.properties).pop();
  return schema ? { tag: '', fields: jsonSchemaFields(schema) } : undefined;
}

/** Values the seam's contract declares a correct answer must carry (`prefer`), laid over an answer. */
export function withPreferred(text: string, contract?: Contract): string {
  const prefer = contract?.prefer as Record<string, unknown> | undefined;
  if (!prefer || typeof prefer !== 'object') return text;
  try { return JSON.stringify({ ...JSON.parse(text), ...prefer }); } catch { return text; }
}

/** Fills a field from the request; undefined means "use the schema's own default". */
export type Filler = (f: Field, path: string) => unknown;

/**
 * THE DEFAULT ANSWER for any seam: the contract the prompt renders, else the JSON exemplar it shows,
 * built with the seam's filler (values from the request). A seam with neither states no format.
 */
export function defaultAnswer(prompt: string, contract: Contract | undefined, filler: Filler = () => undefined, templateText = ''): string | null {
  const rendered = renderedFor(prompt, contract);
  if (rendered) {
    const body = JSON.stringify(build(rendered.fields, filler), null, 2);
    return rendered.tag ? `<${rendered.tag}>\n${body}\n</${rendered.tag}>` : withPreferred(body, contract);
  }
  const ex = exemplar(prompt, contract, templateText);
  if (ex) return withPreferred(JSON.stringify(fill(ex, (_k, o) => o[0])), contract);
  return null;
}
