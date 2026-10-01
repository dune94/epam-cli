/**
 * A FACT ABOUT THE CODELINE REACHES AN AGENT AS A RELATIVE PATH.
 *
 * Operator, 2026-10-01: "hard coded local paths are not generated into prompts or SI text. This is
 * not permitted. Relative paths only." 106 of 115 prompts in the brownfield rehearsal carried
 * absolute paths — mostly the codelines' own locations, written into context blocks by the engine.
 *
 * EXECUTED: the real relativiser, and the real engine renderer filling a real template.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { relativizeLocalPaths } = require(join(__dirname, '../../../orchestrations/scripts/lib/relative-paths.js'));

const estate = join(tmpdir(), 'a-run', 'codelines');
const codeline = join(estate, 'site-a');

describe('a fact about the codeline is a relative path', () => {
  it('inside the agent\'s project root: relative to it; the root itself is "."', () => {
    expect(relativizeLocalPaths(`read ${join(codeline, 'src', 'a.ts')} and ${codeline}`, [codeline, estate])).toBe('read src/a.ts and .');
  });

  it('inside the codelines folder: relative to it — the nearest base wins', () => {
    expect(relativizeLocalPaths(`- shared (${join(estate, 'shared-lib')}) deps`, [codeline, estate])).toBe('- shared (shared-lib) deps');
  });

  it('leaves alone what is under neither, and anything that is not a local path', () => {
    const other = join(tmpdir(), 'elsewhere', 'x.json');
    const text = `${other} https://example.com/a/b /rest/api/3/issue src/x.ts`;
    expect(relativizeLocalPaths(text, [codeline, estate])).toBe(text);
  });

  it('a base that is a prefix of another name is not a parent of it', () => {
    expect(relativizeLocalPaths(`${codeline}-old/x`, [codeline])).toBe(`${codeline}-old/x`);
  });

  it('THE FILL-IN POINT: a real template filled with a codeline path carries it relative', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { renderEngineTemplate } = require(join(__dirname, '../../../orchestrations/scripts/lib/engine-prompt.js'));
    const prev = { r: process.env.PROJECT_ROOT, e: process.env.JIRA_CODELINE_ROOT };
    process.env.PROJECT_ROOT = codeline; process.env.JIRA_CODELINE_ROOT = estate;
    try {
      const out = renderEngineTemplate('prd-configuration-block', { __PRD_CONFIGURATION_JSON__: JSON.stringify({ dir: join(codeline, 'src'), other: join(estate, 'shared-lib') }) });
      expect(out, 'the template rendered nothing — this proves nothing').toMatch(/src/);
      expect(out).not.toContain(estate);
      expect(out).toContain('"src"');
      expect(out).toContain('"shared-lib"');
    } finally {
      if (prev.r === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = prev.r;
      if (prev.e === undefined) delete process.env.JIRA_CODELINE_ROOT; else process.env.JIRA_CODELINE_ROOT = prev.e;
    }
  });
});
