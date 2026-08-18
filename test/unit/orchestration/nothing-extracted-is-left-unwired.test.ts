/**
 * NOTHING EXTRACTED IS LEFT UNWIRED.
 *
 * Operator, 2026-08-16: "if a plug in or handler or prompt you must wire it. you are not
 * permitted to say later it was not wired."
 *
 * An unwired artefact is worse than no artefact. The old code still runs, so nothing looks
 * broken; the new file looks like progress; and the next person edits the template while the
 * script goes on sending the original text. This pipeline has already paid for that exact shape —
 * a coupled-file gate that was committed, tested, and had never once executed because it resolved
 * a path nothing provisions.
 *
 * So orphan detection is automatic. "I'll wire it next" is precisely the intention that gets
 * lost, and a test is the only form of that promise worth anything.
 *
 * WHAT COUNTS AS WIRED. A template is wired when some shipped script or module renders it BY ID —
 * render_engine_prompt <id>, renderEngineTemplate('<id>'), or a prompt-library render of it. A
 * template that only a test refers to is not wired: a test can exercise an artefact the pipeline
 * never reaches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations');
const TEMPLATES = join(ORCH, 'prompts/templates');

/** Every shipped source file — deliberately excluding test/, so a test cannot count as wiring. */
function shippedSources(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'templates', 'logs', 'runs', 'archive', 'test']);
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (skip.has(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (/\.(sh|js|mjs|ts)$/.test(e)) out.push(p);
    }
  };
  walk(join(ORCH, 'scripts'));
  walk(join(ORCH, 'plugins'));
  // src/ TOO, in TypeScript as well as JS. The CLI renders templates now — the scaffold prompts
  // and the plan-mode and squad briefs — and a guard that cannot see that directory reported them
  // as rendered by nothing, which is the same blindness that let them sit in code unnoticed.
  walk(join(ROOT, 'src'));
  return out;
}

const shippedText = (): string =>
  shippedSources().map((f) => readFileSync(f, 'utf8')).join('\n');

const templateIds = (): string[] =>
  readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

/** Templates the ENGINE renders for itself before any agent seam exists. */
function selfDeclaredEngineOnly(id: string): boolean {
  const doc = JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8'));
  return Array.isArray(doc.seams) && doc.seams.length === 0 && !!doc.consumer;
}

describe('the wiring check is real', () => {
  it('there are templates and sources to check', () => {
    expect(templateIds().length).toBeGreaterThan(40);
    expect(shippedSources().length).toBeGreaterThan(30);
  });

  it('it can tell a wired template from an unwired one', () => {
    // Non-vacuity: a template known to be rendered must be found, and an invented id must not.
    const text = shippedText();
    expect(text).toMatch(/story-writer-main/);
    expect(text).not.toMatch(/kramble-widget-template/);
  });
});

describe('every template is rendered by the pipeline', () => {
  it('no template exists that nothing renders', () => {
    // Lines of shipped code that are not comments: a template named only in a comment explaining
    // where it USED to live is not wired by that mention.
    const nonComment = shippedSources()
      .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l));

    const orphans = templateIds().filter((id) => {
      if (selfDeclaredEngineOnly(id)) return false;   // rendered by the builder, by declaration
      // THE ID APPEARS IN SHIPPED CODE, in a line that is not a comment.
      //
      // Requiring the id immediately after a render call was too strict and reported four WIRED
      // templates as orphans: the pipeline also renders INDIRECTLY — render_engine_prompt
      // "$_sum_template" assigns the id to a variable first, and the seam path resolves a template
      // from the registry rather than naming it at the call site. What still fails is a template
      // whose id appears nowhere in shipped code at all, which is the state this guard is for.
      const idRe = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return !nonComment.some((l) => idRe.test(l));
    });
    expect(orphans,
      `${orphans.length} template(s) exist that no shipped script renders. Each is either wiring `
      + `that was never finished, or a template that should not exist:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('every extracted handler is invoked', () => {
  it('no handler module exists that nothing requires', () => {
    // Handlers are programs lifted out of shell heredocs. One that nothing invokes leaves the
    // inline copy still running — the change looks done and nothing about it took effect.
    const dir = join(ORCH, 'scripts/lib/handlers');
    let handlers: string[] = [];
    try { handlers = readdirSync(dir).filter((f) => /\.(js|py)$/.test(f)); } catch { return; }
    if (!handlers.length) return;
    const text = shippedText();
    // A handler reached two ways. Most are INVOKED by a script, which names the file. A few are
    // shared modules IMPORTED by other handlers — the one copy of a rule several of them need —
    // and those are named by module, without the extension. Both count as wired; neither leaves an
    // inline copy running.
    const importedByHandler = new Set<string>();
    for (const h of handlers) {
      const src = readFileSync(join(dir, h), 'utf8');
      for (const m of src.matchAll(/^\s*(?:from\s+([A-Za-z_][\w]*)\s+import|import\s+([A-Za-z_][\w]*))/gm)) {
        importedByHandler.add(`${m[1] || m[2]}.py`);
      }
      for (const m of src.matchAll(/require\(['"]\.\/([\w.-]+?)(?:\.js)?['"]\)/g)) {
        importedByHandler.add(`${m[1]}.js`);
      }
    }
    const orphans = handlers.filter((h) => !text.includes(h) && !importedByHandler.has(h));
    expect(orphans,
      `${orphans.length} handler(s) are never invoked, so the inline code they replaced is still `
      + `what runs:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });
});
