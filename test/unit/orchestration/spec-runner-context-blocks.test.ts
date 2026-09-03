/**
 * THE CONTEXT BLOCKS A SPEC PROMPT IS BUILT FROM.
 *
 * Each returns a fragment that is pasted into a prompt. They share one failure mode: returning ''
 * when they should have returned content. Nothing downstream can tell an intentionally-absent block
 * from a block that silently failed to build, so the agent simply answers with less context and the
 * answer looks normal.
 *
 * publishedContracts also carries a real crash: it is called while building a prompt, and
 * path.join(null, ...) throws, so an unresolvable codeline took the whole spec pass down.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
const { publishedContracts, specCorrectiveNote, buildGateExec, codelineScopeBlock } = runner;

describe('publishedContracts never takes the spec pass down', () => {
  it('an unresolvable codeline returns empty instead of throwing', () => {
    // A story whose codeline cannot be resolved is ordinary — mocks, greenfield, a lane not yet
    // created. path.join(null, ...) throws, and this runs while building a prompt.
    for (const bad of [null, undefined, '', 0, false]) {
      expect(() => publishedContracts(bad, { id: 'S-1' }),
        `repoPath=${JSON.stringify(bad)} threw`).not.toThrow();
      expect(publishedContracts(bad, { id: 'S-1' })).toBe('');
    }
  });

  it('a repo with no .contracts directory returns empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    expect(publishedContracts(dir, { id: 'S-1' })).toBe('');
  });

  it('an EMPTY .contracts directory returns empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    mkdirSync(join(dir, '.contracts'));
    expect(publishedContracts(dir, { id: 'S-1' })).toBe('');
  });

  it('contracts that are present but blank return empty — a blank file is not content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    mkdirSync(join(dir, '.contracts'));
    writeFileSync(join(dir, '.contracts/a.md'), '   \n\n');
    expect(publishedContracts(dir, { id: 'S-1' })).toBe('');
  });

  it('non-markdown files are ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    mkdirSync(join(dir, '.contracts'));
    writeFileSync(join(dir, '.contracts/notes.txt'), 'not a contract');
    expect(publishedContracts(dir, { id: 'S-1' })).toBe('');
  });

  it('a real contract is rendered, named by its file, and says how many codelines the story spans', () => {
    // The positive half — without it every assertion above passes on a function that always
    // returns '', which is exactly what a silently broken block looks like.
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    mkdirSync(join(dir, '.contracts'));
    writeFileSync(join(dir, '.contracts/payments-api.md'), 'POST /pay returns 201\n');
    const out = publishedContracts(dir, { id: 'S-1', codelines: ['be', 'fe'] });
    expect(out, 'a real contract produced no block at all').not.toBe('');
    expect(out).toContain('payments-api');
    expect(out).toContain('POST /pay returns 201');
    expect(out, 'the block does not say the story spans several codelines').toContain('2');
  });

  it('and a single-codeline story gets no spanning sentence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    mkdirSync(join(dir, '.contracts'));
    writeFileSync(join(dir, '.contracts/a.md'), 'content\n');
    const out = publishedContracts(dir, { id: 'S-1' });
    expect(out).toContain('content');
    expect(out, 'a story spanning nothing was told it spans codelines').not.toMatch(/spans \d+ codelines/);
  });
});

describe('specCorrectiveNote says what was wrong with the LAST answer', () => {
  it('names tool calls, and tells the model it has none', () => {
    const n = specCorrectiveNote('tool-call');
    expect(n).toContain('REJECTED');
    expect(n, 'the model is not told it has no tools').toMatch(/NO tools|cannot call/i);
  });

  it('names prose, and demands raw JSON', () => {
    const n = specCorrectiveNote('prose');
    expect(n).toContain('REJECTED');
    expect(n).toMatch(/prose/i);
    expect(n).toMatch(/JSON/);
  });

  it('names malformed JSON, and says specifically what to fix', () => {
    const n = specCorrectiveNote('malformed-json');
    expect(n).toContain('REJECTED');
    expect(n, 'it does not say what makes the JSON invalid')
      .toMatch(/trailing comma|quote every key|unescaped/i);
  });

  it('an unknown kind produces NOTHING rather than a vague scolding', () => {
    // A note that says "your answer was rejected" without saying why sends the model somewhere else.
    for (const k of ['', null, undefined, 'something-else', 42]) {
      expect(specCorrectiveNote(k as any), `kind=${String(k)} produced a note`).toBe('');
    }
  });

  it('the three notes are distinct — each identifies WHICH failure occurred', () => {
    const notes = ['tool-call', 'prose', 'malformed-json'].map(specCorrectiveNote);
    expect(new Set(notes).size, 'two failure kinds produce the same note').toBe(3);
  });
});

describe('buildGateExec refuses to route somewhere nobody chose', () => {
  it('REFUSES when its seam ladder resolves no model, rather than routing to a vendor literal', () => {
    // Both call sites for this review used to end in a vendor literal that always answered, so a
    // ladder that resolved nothing was indistinguishable from one that resolved correctly. Failing
    // here is the point: an unresolved ladder must stop the call, not pick something.
    expect(() => buildGateExec('/bin/runner', { ...process.env, ORCH_GATE_PROVIDER: 'claude' }))
      .toThrow(/no model resolved from its seam ladder/);
  });

  it('and it names the seam in the refusal, so the operator knows which ladder to fix', () => {
    let msg = '';
    try { buildGateExec('/bin/runner', { ...process.env, ORCH_GATE_PROVIDER: '' }); }
    catch (e) { msg = String((e as Error).message); }
    expect(msg, 'the refusal does not name the seam').toContain('prd-change-reviewer');
  });
});

describe('codelineScopeBlock only speaks when this lane shares work with another', () => {
  it('no lane resolved means no block', () => {
    expect(codelineScopeBlock({}, [{ id: 'S-1', codelines: ['a', 'b'] }])).toBe('');
    expect(codelineScopeBlock(null, [])).toBe('');
  });

  it('no spanning story means no block, even when a lane is resolved', () => {
    const prd = { project: { outputDir: '/o/be', outputDirs: ['/o/be', '/o/fe'] } };
    expect(codelineScopeBlock(prd, [{ id: 'S-1', codelines: ['be'] }]),
      'a single-codeline story produced a cross-lane warning').toBe('');
    expect(codelineScopeBlock(prd, [])).toBe('');
    expect(codelineScopeBlock(prd, null)).toBe('');
  });

  it('a story spanning ONLY this lane produces no block — there is no other lane to name', () => {
    const prd = { project: { outputDir: '/o/be', outputDirs: ['/o/be', '/o/fe'] } };
    expect(codelineScopeBlock(prd, [{ id: 'S-1', codelines: ['be', 'be'] }])).toBe('');
  });
});
