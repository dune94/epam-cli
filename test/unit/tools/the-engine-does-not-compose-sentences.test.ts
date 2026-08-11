/**
 * THE ENGINE EMITS CODES AND DATA. IT DOES NOT WRITE ENGLISH.
 *
 * Every agent-facing message in the tools was a sentence composed in engine code:
 *
 *     "You already read X earlier in this attempt and it has NOT changed since ..."
 *     "[scope-guard] Write blocked: X — it is declared by ANOTHER story ..."
 *     "LOOP PROTECTION: write_file has now targeted the same file 9 times ..."
 *
 * That is hardcoding. It is not stack-specific hardcoding — no extension, filename or language
 * appears in any of them — and that is exactly why it survived review: "no stack facts" was
 * treated as satisfying the rule. The rule is broader. Prose in the engine cannot be changed per
 * project without editing the engine, cannot be translated, cannot be tuned when a model responds
 * badly to a phrasing, and drifts the moment a second call site says the same thing differently.
 *
 * THE SHAPE: a tool reports {code, ...data}. Wording is supplied by a project-owned catalog. When
 * no catalog is present the engine emits the structured form verbatim — it does NOT fall back to a
 * built-in sentence, because a fallback sentence is the hardcoding with an extra branch in front
 * of it.
 *
 * The codes are a closed vocabulary the pipeline owns; the words are the project's.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderAgentMessage } from '../../../src/tools/messages.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SAVED = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

function catalog(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'msgs-')); dirs.push(dir);
  const p = join(dir, 'agent-messages.json');
  writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

describe('with a project catalog, the project supplies the words', () => {
  it('renders the catalog entry, interpolating the data', () => {
    process.env.EPAM_AGENT_MESSAGE_CATALOG = catalog({
      write_refused: 'No: {path} belongs to {owner}.',
    });
    const out = renderAgentMessage('write_refused', { path: '/a/b.x', owner: 'S-2' });
    expect(out).toBe('No: /a/b.x belongs to S-2.');
  });

  it('a different catalog produces different words for the same code', () => {
    // The point of the change: wording is tunable without touching the engine.
    process.env.EPAM_AGENT_MESSAGE_CATALOG = catalog({ write_refused: 'DENIED {path}' });
    expect(renderAgentMessage('write_refused', { path: '/a/b.x' })).toBe('DENIED /a/b.x');
  });

  it('a placeholder with no matching datum is left visible, not silently blanked', () => {
    // A message that quietly loses a value reads as complete while being wrong.
    process.env.EPAM_AGENT_MESSAGE_CATALOG = catalog({ x: 'a={a} b={b}' });
    expect(renderAgentMessage('x', { a: '1' })).toContain('{b}');
  });
});

describe('with NO catalog, the engine still does not invent prose', () => {
  it('emits the structured form', () => {
    delete process.env.EPAM_AGENT_MESSAGE_CATALOG;
    const out = renderAgentMessage('write_refused', { path: '/a/b.x', cause: 'owned_by_other_story' });
    expect(out).toContain('write_refused');
    expect(out).toContain('/a/b.x');
    expect(out).toContain('owned_by_other_story');
  });

  it('the structured form contains no sentence', () => {
    delete process.env.EPAM_AGENT_MESSAGE_CATALOG;
    const out = renderAgentMessage('same_target_repeat', { tool: 'write_file', count: 9 });
    // No English connectives: a "helpful" default sentence is the hardcoding it replaces.
    expect(out.toLowerCase()).not.toMatch(/\b(you|the|this|is|was|has|not|please|do not)\b/);
  });

  it('an unreadable catalog degrades to the structured form, not to a built-in sentence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msgs-bad-')); dirs.push(dir);
    const p = join(dir, 'agent-messages.json');
    writeFileSync(p, '{ not json');
    process.env.EPAM_AGENT_MESSAGE_CATALOG = p;
    const out = renderAgentMessage('write_refused', { path: '/a/b.x' });
    expect(out).toContain('write_refused');
    expect(out.toLowerCase()).not.toMatch(/\b(you|belongs|blocked)\b/);
  });

  it('a code the catalog does not define falls back to the structured form', () => {
    process.env.EPAM_AGENT_MESSAGE_CATALOG = catalog({ other_code: 'x' });
    const out = renderAgentMessage('write_refused', { path: '/a/b.x' });
    expect(out).toContain('write_refused');
  });
});

describe('THE SWEEP: no agent-facing sentence is composed in the tools', () => {
  const FILES = [
    'src/tools/builtin/WriteFile.ts',
    'src/tools/builtin/ReadFile.ts',
    'src/agent/LoopDetector.ts',
  ];

  it('no tool builds a multi-word English message in code', () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      const src = readFileSync(join(__dirname, '../../../', rel), 'utf8');
      let inSchema = false;
      src.split('\n').forEach((line, i) => {
        if (/inputSchema\s*:/.test(line)) inSchema = true;
        if (inSchema && /^\s{4}\}[,;]?\s*$/.test(line)) inSchema = false;
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        // A tool's inputSchema `description` is its INTERFACE, not a message about an event.
        // It must always be present and meaningful — a model that reads `read_file_description`
        // instead of a sentence does not know the tool exists or what its parameters mean, so it
        // cannot degrade to a bare code the way a runtime message can. The catalog may still
        // override it; what it must not do is disappear. Runtime messages are the opposite: the
        // code IS the truth and the words are the project's.
        if (/^description:/.test(t)) return;
        if (/^readonly description\s*=/.test(t)) return;   // the tool's own interface, same rule
        if (inSchema) return;
        // A quoted run of >=4 words containing a lowercase English connective.
        const m = line.match(/['"`][^'"`]*\b(you|the|this|that|is|are|was|has|not|please)\b[^'"`]{15,}['"`]/i);
        if (m) offenders.push(`${rel}:${i + 1}  ${m[0].slice(0, 70)}`);
      });
    }
    expect(
      offenders,
      'these compose English in the engine; move the wording to the project catalog and emit ' +
      '{code, ...data} instead',
    ).toEqual([]);
  });
});
