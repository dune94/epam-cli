/**
 * THE ANSWER CONTRACT AS THE PIPELINE RENDERS IT INTO THE PROMPT.
 *
 * A structured seam's prompt carries its schema inside a tagged block:
 *
 *   <TAG>
 *   {
 *     "field": <string> one of "a" | "b"
 *        // what it means.   (optional),
 *     "list": [ {
 *         "inner": <array>
 *     } ]
 *   }
 *   </TAG>
 *
 * That block is rendered from the pipeline's own schema on every call, so reading it is reading the
 * current code's contract — the mock moves with the code because it is handed the contract each
 * time. This parses it into a small schema tree; nothing about any particular seam is known here.
 */
export type Field = { name: string; type: string; enum?: string[]; optional: boolean; note: string; items?: Field[]; fields?: Field[] };
export type Rendered = { tag: string; fields: Field[] };

/** The tagged schema blocks a prompt carries: <TAG> … </TAG> whose body is the annotated shape. */
export function renderedSchemas(prompt: string): Rendered[] {
  const out: Rendered[] = [];
  const re = /<([A-Z][A-Z0-9_]+)>\s*\n([\s\S]*?)\n\s*<\/\1>/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    const fields = parseBody(m[2]);
    if (fields.length) out.push({ tag: m[1], fields });
  }
  return out;
}

function parseBody(body: string): Field[] {
  const lines = body.split('\n');
  let i = 0;
  const KEY = /^\s*"([^"]+)"\s*:\s*(.*)$/;
  const parseObject = (): Field[] => {
    const fields: Field[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*\}/.test(line)) { i += 1; return fields; }
      const k = KEY.exec(line);
      if (!k) { i += 1; continue; }
      i += 1;
      const rest = k[2].trim();
      const f: Field = { name: k[1], type: 'string', optional: false, note: '' };
      if (/^\[\s*\{/.test(rest)) { f.type = 'array'; f.items = parseObject(); while (i < lines.length && /^\s*\]/.test(lines[i]) === false && !KEY.test(lines[i]) && !/^\s*\}/.test(lines[i])) i += 1; if (i < lines.length && /^\s*\]/.test(lines[i])) i += 1; }
      else if (/^\{/.test(rest)) { f.type = 'object'; f.fields = parseObject(); }
      else {
        const t = /^<(\w+)>/.exec(rest); if (t) f.type = t[1];
        const e = /one of\s+(.+?)(?:$|\s*\/\/)/.exec(rest);
        if (e) f.enum = [...e[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      }
      // The annotation lines that follow (// …), up to the next key or closing brace.
      while (i < lines.length && /^\s*\/\//.test(lines[i])) { f.note += `${lines[i].replace(/^\s*\/\/\s?/, '')} `; i += 1; }
      if (/\(optional\)/.test(`${rest} ${f.note}`)) f.optional = true;
      fields.push(f);
    }
    return fields;
  };
  // Skip to the opening brace of the top object.
  while (i < lines.length && !/^\s*\{/.test(lines[i])) i += 1;
  i += 1;
  return parseObject();
}

/**
 * A value for every field, from the schema and a filler that knows the request. Optional fields are
 * included (a model usually fills them); arrays get one entry — the filler may return more.
 */
export function build(fields: Field[], fill: (f: Field, path: string) => unknown, path = ''): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of fields) {
    const p = path ? `${path}.${f.name}` : f.name;
    const own = fill(f, p);
    if (own !== undefined) { o[f.name] = own; continue; }
    // A list is EMPTY unless a seam's filler knows its real entries: a model does not invent items,
    // and an invented one flows downstream as if it were real (a split child 'id from the request').
    if (f.type === 'array') o[f.name] = [];
    else if (f.type === 'object' && f.fields) o[f.name] = build(f.fields, fill, p);
    else if (f.enum && f.enum.length) o[f.name] = f.enum[0];
    else if (f.type === 'number' || f.type === 'integer') o[f.name] = 1;
    else if (f.type === 'boolean') o[f.name] = true;
    else o[f.name] = `${f.name} from the request`;
  }
  return o;
}

/** Why a value does not satisfy a rendered schema: missing required fields, values outside an enum. */
export function violations(fields: Field[], v: unknown, path = ''): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${path || 'answer'} is not an object`];
  const o = v as Record<string, unknown>; const out: string[] = [];
  for (const f of fields) {
    const p = path ? `${path}.${f.name}` : f.name;
    if (!(f.name in o)) { if (!f.optional) out.push(`required field '${p}' is missing`); continue; }
    const x = o[f.name];
    if (f.enum && f.enum.length && typeof x === 'string' && !f.enum.includes(x)) out.push(`'${p}' = "${x}" is not one of ${f.enum.join(' | ')}`);
    if (f.type === 'array' && f.items && Array.isArray(x)) x.forEach((e, i) => out.push(...violations(f.items!, e, `${p}[${i}]`)));
    if (f.type === 'object' && f.fields) out.push(...violations(f.fields, x, p));
  }
  return out;
}

/**
 * A JSON SCHEMA the prompt carries (`{"type":"object","properties":…,"required":[…]}`), as fields.
 * Some seams hand the model their schema this way — the pipeline's own validator's schema — and it
 * is read exactly like a rendered block: types, enums, required.
 */
export function jsonSchemaFields(schema: any, defs: any = schema?.$defs || schema?.definitions || {}): Field[] {
  const deref = (s: any): any => (s && s.$ref ? defs[String(s.$ref).split('/').pop()!] || {} : s || {});
  const req = new Set<string>(schema?.required || []);
  return Object.entries<any>(schema?.properties || {}).map(([name, raw]) => {
    const p = deref(raw);
    const alt = (p.anyOf || p.oneOf || []).map(deref).find((x: any) => x.type && x.type !== 'null') || p;
    const type = Array.isArray(alt.type) ? alt.type.find((t: string) => t !== 'null') : alt.type || (alt.enum ? 'string' : 'string');
    const f: Field = { name, type, optional: !req.has(name), note: String(p.description || alt.description || ''), enum: alt.enum };
    if (type === 'array' && deref(alt.items)?.properties) f.items = jsonSchemaFields(deref(alt.items), defs);
    if (type === 'object' && alt.properties) f.fields = jsonSchemaFields(alt, defs);
    return f;
  });
}
