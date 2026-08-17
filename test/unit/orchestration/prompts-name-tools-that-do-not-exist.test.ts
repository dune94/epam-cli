/**
 * A PROMPT CAN INSTRUCT A TOOL THAT DOES NOT EXIST, OR ONE ITS SEAM DOES NOT GRANT.
 *
 * The estate-survey defect (2026-08-17) was a prompt documenting a CALL SHAPE the tool refuses:
 * 16 calls, all rejected, both codelines reported unexamined, and the roster assembled on guesses.
 * That instance is fixed and guarded by prompts-advertise-tool-calls-the-tool-rejects.test.ts.
 * This covers the two siblings of it, which nothing checked:
 *
 *   NAME    a prompt instructs a tool nothing registers — renamed, or plausibly invented. The
 *           agent gets "unknown tool" and either loops or answers blind.
 *   GRANT   a prompt instructs a real tool its OWN SEAM does not grant. The agent is told to run
 *           tests by a prompt whose seam is read-only, so it cannot comply however hard it tries —
 *           and an agent that cannot comply with its instructions invents something instead.
 *
 * The prompt layer and the tool layer are authored apart, so both fail only in a live run, at a
 * seam, hours in, with the run already spending. These assert the JOIN.
 *
 * ON MATCHING PROSE: a prompt names tools in sentences, and matching every snake_case token yields
 * 44 JSON field names against 4 real tools. So matching is confined to INSTRUCTION positions —
 * a call, a backticked name, "use X", "the X tool". That under-matches rather than over-matches,
 * and both tests assert they examined a non-empty set so a silent regression in the matcher shows
 * up as a failure instead of a pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const PLUGINS = join(ROOT, 'orchestrations/plugins');
const BUILTIN = join(ROOT, 'src/tools/builtin');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const GRANT_CFG = join(ROOT, 'orchestrations/config/spec-mode-defaults.json');

/** Every tool name a plugin registers, plus every builtin by its snake_case call name. */
function realTools(): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync(PLUGINS).filter((x) => x.endsWith('.js'))) {
    for (const m of readFileSync(join(PLUGINS, f), 'utf8').matchAll(/name:\s*['"]([a-z][a-z0-9_]*)['"]/g)) {
      names.add(m[1]);
    }
  }
  for (const f of readdirSync(BUILTIN).filter((x) => x.endsWith('.ts'))) {
    names.add(f.replace(/\.ts$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
  }
  return names;
}

/** Prompt bodies, flattened — a body is a string or a map of named blocks. */
function prompts(): Array<{ id: string; body: string }> {
  return readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).map((f) => {
    const j = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
    const body = typeof j.body === 'string'
      ? j.body
      : Object.values(j.body || {}).filter((v) => typeof v === 'string').join('\n');
    return { id: f.replace(/\.json$/, ''), body };
  });
}

/** Names appearing where the prompt is INSTRUCTING a call, not merely describing data. */
function instructedTools(body: string): Set<string> {
  const out = new Set<string>();
  const pats = [
    /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g,
    /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s+tool\b/g,
    /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g,
    /\b(?:use|call|via|run)\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi,
  ];
  for (const p of pats) for (const m of body.matchAll(p)) out.add(m[1]);
  return out;
}

const REAL = realTools();
const PROMPTS = prompts();
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

/** template id -> the seams that run it, with each seam's declared grant. */
const seamsFor: Record<string, Array<{ name: string; grant: string }>> = {};
for (const [name, p] of Object.entries<any>(registry.profiles || {})) {
  if (p && p.template) (seamsFor[p.template] ||= []).push({ name, grant: p.toolGrant });
}

/** grant kind -> the privileged tools it adds, from the project's own grant config. */
function grantAdds(): Record<string, string[]> {
  const cfg = JSON.parse(readFileSync(GRANT_CFG, 'utf8'));
  let found: any = null;
  (function walk(o: any) {
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (v && typeof v === 'object') {
        if (v['read-only'] && v.write) found = v; else walk(v);
      }
    }
  })(cfg);
  if (!found) throw new Error('grant kinds not found in spec-mode-defaults.json');
  return Object.fromEntries(Object.entries<any>(found).map(([k, v]) => [k, v.adds || []]));
}
const ADDS = grantAdds();
/** Only these are actually gated by a grant; everything else is the read-only floor. */
const GATED = ['bash', 'write_file', 'fetch_url'];

describe('prompts name tools that do not exist', () => {
  it('the inventories are non-empty — otherwise every check below is vacuous', () => {
    expect(REAL.size, 'no tools discovered; the inventory scan is broken').toBeGreaterThan(10);
    expect(REAL.has('codegraph_query'), 'the plugin scan missed a known tool').toBe(true);
    expect(REAL.has('read_file'), 'the builtin scan missed a known tool').toBe(true);
    expect(PROMPTS.length, 'no prompt templates were read').toBeGreaterThan(10);
    expect(Object.keys(seamsFor).length, 'no template maps to a seam').toBeGreaterThan(20);
    expect(ADDS.write, 'the write grant has no adds — the grant config read wrong').toContain('write_file');
  });

  it('EVERY TOOL A PROMPT INSTRUCTS EXISTS', () => {
    const unknown: string[] = [];
    let examined = 0;
    for (const { id, body } of PROMPTS) {
      for (const name of instructedTools(body)) {
        examined++;
        if (!REAL.has(name)) unknown.push(`${id}: ${name}`);
      }
    }
    // A matcher that stops matching would pass this test while checking nothing.
    expect(examined, 'no tool instruction was matched at all — the matcher has regressed')
      .toBeGreaterThan(0);
    expect(unknown, `prompts instruct tool(s) nothing registers:\n${unknown.join('\n')}`).toEqual([]);
  });

  it('NO PROMPT INSTRUCTS A TOOL ITS OWN SEAM DOES NOT GRANT', () => {
    const violations: string[] = [];
    let pairs = 0;
    let seamBacked = 0;

    for (const { id, body } of PROMPTS) {
      const seams = seamsFor[id];
      if (!seams) continue; // an auxiliary sub-prompt runs under whichever seam includes it
      seamBacked++;
      for (const tool of GATED) {
        const re = new RegExp(`(\`${tool}\`|\\b${tool}\\s*\\(|\\buse ${tool}\\b|\\b${tool} tool\\b)`, 'i');
        if (!re.test(body)) continue;
        pairs++;
        for (const s of seams) {
          const allowed = ADDS[s.grant] || [];
          if (!allowed.includes(tool)) {
            violations.push(
              `${id} instructs '${tool}', but seam '${s.name}' grants '${s.grant}' (adds: ${allowed.join(', ') || 'none'})`);
          }
        }
      }
    }

    expect(seamBacked, 'no seam-backed prompt was examined').toBeGreaterThan(20);
    expect(pairs, 'no prompt mentions a gated tool — the grant check examined nothing')
      .toBeGreaterThan(0);
    expect(violations,
      `an agent cannot comply with these, however hard it tries:\n${violations.join('\n')}`)
      .toEqual([]);
  });
});
