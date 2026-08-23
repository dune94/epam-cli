/**
 * THE ENGINE PROMPT RENDERER.
 *
 * Extracted after the second migration copied it into a second file, with eighteen still to
 * come. The behaviour that matters is its STRICTNESS: it is the thing standing between a
 * migrated prompt and a run where evidence silently never reached the agent.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/engine-prompt.js');
const { renderEngineTemplate, placeholdersIn } = require(LIB);
const lib = require(join(__dirname, '../../../orchestrations/scripts/lib/prompt-library.js'));

describe('it renders a real template', () => {
  it('substitutes every placeholder', () => {
    // estate-survey is migrated and its placeholders are known, so this exercises the real
    // template zone rather than a fixture that could drift from it.
    const out = renderEngineTemplate('estate-survey', {
      __TICKET_BLOCK__: 'T', __DOC_SECTION__: '', __DEP_SECTION__: '', __CODELINE_BLOCK__: 'C',
    });
    expect(out.length).toBeGreaterThan(500);
    expect(out).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
  });
});

describe('it refuses anything that would reach an agent incomplete', () => {
  it('throws when a value is missing, naming it', () => {
    expect(() => renderEngineTemplate('estate-survey', { __TICKET_BLOCK__: 'T' }))
      .toThrow(/__CODELINE_BLOCK__/);
  });

  it('throws when given a value the template does not use', () => {
    // The same defect from the other end: the caller believes it supplied something.
    expect(() => renderEngineTemplate('estate-survey', {
      __TICKET_BLOCK__: 'T', __DOC_SECTION__: '', __DEP_SECTION__: '', __CODELINE_BLOCK__: 'C',
      __NOT_A_REAL_ONE__: 'x',
    })).toThrow(/__NOT_A_REAL_ONE__/);
  });

  it('throws on a missing template rather than falling back to anything', () => {
    expect(() => renderEngineTemplate('no-such-template-exists', {}))
      .toThrow(/cannot load template/);
  });
});

describe('values are inserted literally', () => {
  it('a dollar-ampersand in a value is not read as a replacement pattern', () => {
    // Diffs, logs, regexes and JSON examples all routinely contain these. As a string
    // replacement, `$&` expands to the matched placeholder and corrupts the evidence.
    const out = renderEngineTemplate('estate-survey', {
      __TICKET_BLOCK__: 'literal $& and $1 and $`',
      __DOC_SECTION__: '', __DEP_SECTION__: '', __CODELINE_BLOCK__: 'C',
    });
    expect(out).toContain('literal $& and $1 and $`');
    expect(out).not.toContain('__TICKET_BLOCK__');
  });
});

/**
 * ADJACENT PLACEHOLDERS.
 *
 * A prompt that ends one block and begins the next with no separator — ${a}${b} in the
 * original source — becomes __A____B__ in the template. Greedy matching swallowed the whole
 * run as ONE token, so spec-agent-openspec, whose opening line carries SEVEN adjacent blocks,
 * declared a placeholder nobody supplies and threw on every render.
 *
 * Substitution by key was always adjacency-safe; only the DERIVATION of the placeholder list
 * was wrong. That is a good reminder that a template's declared list and its body are two
 * things that can disagree.
 */
describe('placeholders that touch are still separate placeholders', () => {
  it('reads two adjacent placeholders as two', () => {
    expect(placeholdersIn('__ALPHA____BETA__')).toEqual(['__ALPHA__', '__BETA__']);
  });

  it('does not split a single placeholder containing underscores', () => {
    expect(placeholdersIn('__STORY_ID__')).toEqual(['__STORY_ID__']);
  });

  it('handles a run of many, as the real template does', () => {
    expect(placeholdersIn('__A____B____C____D__')).toEqual(['__A__', '__B__', '__C__', '__D__']);
  });

  it('every shipped template declares exactly what its body uses', () => {
    // The check that would have caught this at authoring time rather than at render time.
    const dir = join(__dirname, '../../../orchestrations/prompts/templates');
    const bad: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      // A MULTI-BODY TEMPLATE'S DECLARATION IS THE UNION OF ITS PARTS. Reading `body` alone left
      // 13 templates with an empty `used` set, so every one of them was reported as broken while
      // in fact none of them was ever checked — the report named them and the check was blind.
      const bodies = doc.bodies && typeof doc.bodies === 'object'
        ? Object.values(doc.bodies) : [doc.body || ''];
      const used = [...new Set(bodies.flatMap((b: any) => placeholdersIn(b)))].sort();
      const dec = [...(doc.placeholders || [])].sort();
      if (JSON.stringify(used) !== JSON.stringify(dec)) bad.push(f);
    }
    expect(bad, `templates whose declaration disagrees with their body: ${bad.join(', ')}`).toEqual([]);
  });
});

// SUBSTITUTION IS ONE PASS OVER THE BODY — evidence is inserted, never re-read.
//
// Both renderers replaced each placeholder in turn over the accumulating output, so text that
// arrived as a VALUE was rescanned by every later key. Two failures came out of that: a diff
// mentioning another placeholder had that placeholder's content spliced into it, and a diff
// containing any double-underscore token — a Python dunder, a C macro — tripped the leftover
// check and killed the render of a prompt that was in fact complete.
//
// The leftover check could never have caught what it was written for: every placeholder in the
// body is replaced, so nothing body-origin can survive to be found. The only thing it ever saw
// was evidence.
describe('rendering reads the BODY, and the values are inert', () => {
  const mk = (body: string, placeholders: string[]) => {
    const d = mkdtempSync(join(tmpdir(), 'render-'));
    mkdirSync(join(d, 'prompts'), { recursive: true });
    writeFileSync(join(d, 'prompts', 'probe.json'),
      JSON.stringify({ id: 'probe', authority: 'project', body, placeholders }));
    return d;
  };

  it('a placeholder appearing INSIDE a value is left exactly as it arrived', () => {
    const d = mk('DIFF: __A__\nLEVEL: __B__', ['__A__', '__B__']);
    try {
      const out = lib.buildPrompt('probe', d,
        { __A__: 'the writer wrote __B__ in a comment', __B__: 'CLASSIFIED' });
      expect(out, 'a value was substituted into another value').toContain('the writer wrote __B__ in a comment');
      expect(out).toContain('LEVEL: CLASSIFIED');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('a dunder in the evidence does not fail the render', () => {
    const d = mk('DIFF: __A__', ['__A__']);
    try {
      const out = lib.buildPrompt('probe', d, { __A__: '+def __INIT__(self):' });
      expect(out).toBe('DIFF: +def __INIT__(self):');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('and every placeholder the BODY declares is still consumed', () => {
    const d = mk('A=__A__ B=__B__ A again=__A__', ['__A__', '__B__']);
    try {
      const out = lib.buildPrompt('probe', d, { __A__: '1', __B__: '2' });
      expect(out).toBe('A=1 B=2 A again=1');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
