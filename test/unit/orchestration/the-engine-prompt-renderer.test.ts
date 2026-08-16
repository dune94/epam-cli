/**
 * THE ENGINE PROMPT RENDERER.
 *
 * Extracted after the second migration copied it into a second file, with eighteen still to
 * come. The behaviour that matters is its STRICTNESS: it is the thing standing between a
 * migrated prompt and a run where evidence silently never reached the agent.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/engine-prompt.js');
const { renderEngineTemplate } = require(LIB);

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
