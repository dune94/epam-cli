/**
 * THE CODELINE-DISCOVERY PROMPT IS A TEMPLATE.
 *
 * 2 of the twenty seams. This prompt decides which repositories a ticket's changes belong to,
 * so its wording sets the SCOPE of the entire run — a migration that reworded it would change
 * which client repos get modified.
 *
 * The golden was captured mechanically from the shipped builder before the move, and it
 * earned its keep straight away: the first template was extracted from the SOURCE text and
 * kept the JS escapes, so a backslash-quote stayed two characters instead of one and the
 * rendered prompt differed by two bytes. The template is now built from the OUTPUT.
 *
 * Requiring this module used to exit the requiring process — its argument check ran at import
 * time — so scoping that to direct invocation is what made the migration provable at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/codeline-discovery.golden.json');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/codeline-discovery.json');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const MODULE = join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js');

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

describe('the golden capture is real', () => {
  it('matches its own digest', () => {
    const g = golden();
    expect(createHash('sha256').update(g.output).digest('hex')).toBe(g.sha256);
    expect(g.output.length).toBeGreaterThan(1000);
  });
});

describe('the prompt lives in the template layer', () => {
  it('the template exists and the seam declares it', () => {
    expect(existsSync(TEMPLATE)).toBe(true);
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(r.profiles['codeline-discovery']?.template).toBe('codeline-discovery');
  });

  it('declares exactly the placeholders its body uses', () => {
    const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
    expect([...doc.placeholders].sort()).toEqual(used);
  });

  it('carries no fixture value, project or repo name of its own', () => {
    const body = JSON.parse(readFileSync(TEMPLATE, 'utf8')).body as string;
    for (const lit of ['AA-1', 'repo-one', 'repo-two', 'metrolinx', 'gotransit', '@scope/one']) {
      expect(body, `the template hardcodes '${lit}'`).not.toContain(lit);
    }
  });

  it('carries no DOUBLE-escaped quote from the extraction', () => {
    // The exact defect the golden caught. A single \" is legitimate here — the prompt SHOWS
    // the agent an example of escaped JSON — so the tell is a doubled backslash, which is
    // what survives when the template is built from source text instead of from output.
    const body = JSON.parse(readFileSync(TEMPLATE, 'utf8')).body as string;
    expect(body, 'a double-escaped quote survived extraction').not.toContain('\\\\"');
  });
});

describe('the migration changed no bytes', () => {
  it('reproduces the captured prompt exactly', () => {
    const g = golden();
    const { buildDiscoveryPrompt } = require(MODULE);
    expect(buildDiscoveryPrompt(g.fixtures.ISSUES, g.fixtures.MANIFEST)).toBe(g.output);
  });

  it('the module can be required without running a discovery pass', () => {
    // Unscoped, its argument check exited the requiring process.
    const m = require(MODULE);
    expect(typeof m.buildDiscoveryPrompt).toBe('function');
  });
});
