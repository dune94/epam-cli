/**
 * THE ROSTER-REVIEW PROMPT IS A TEMPLATE.
 *
 * 3 of the twenty seams. The roster reviewer is the only adversary the roster has — it is what
 * stops a defective brief reaching an implementer — so a reworded sentence here changes which
 * briefs survive, and every story runs under one of them.
 *
 * BOTH branches are pinned. When no documentation was fetched, the prompt says something
 * entirely different: any vendor claim is unverifiable. Pinning only the populated case would
 * let that branch rot unnoticed, and it is the branch that runs whenever a ticket has no links.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/roster-review.golden.json');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/roster-review.json');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

describe('the golden capture is real', () => {
  it('matches its digests and the branches genuinely differ', () => {
    const g = golden();
    expect(createHash('sha256').update(g.output.withDocs).digest('hex')).toBe(g.sha256.withDocs);
    expect(createHash('sha256').update(g.output.noDocs).digest('hex')).toBe(g.sha256.noDocs);
    expect(g.output.withDocs).not.toBe(g.output.noDocs);
  });
});

describe('the prompt lives in the template layer', () => {
  it('the template exists and the seam declares it', () => {
    expect(existsSync(TEMPLATE)).toBe(true);
    expect(JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles['roster-review']?.template)
      .toBe('roster-review');
  });

  it('declares exactly the placeholders its body uses', () => {
    const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
    expect([...doc.placeholders].sort()).toEqual(used);
  });

  it('carries no sentinel from the capture and no project fact', () => {
    const body = JSON.parse(readFileSync(TEMPLATE, 'utf8')).body as string;
    for (const lit of ['PERSONA_TEXT', 'BRIEF_BLOCK_TEXT', 'TICKET_BLOCK_TEXT', 'metrolinx', 'gotransit']) {
      expect(body, `the template contains '${lit}'`).not.toContain(lit);
    }
  });
});

describe('the migration changed no bytes', () => {
  const build = () => require(RUNNER).buildRosterReviewPrompt;

  it('reproduces the documented branch exactly', () => {
    const g = golden();
    expect(build()(g.fixtures.V)).toBe(g.output.withDocs);
  });

  it('reproduces the undocumented branch exactly', () => {
    const g = golden();
    expect(build()(g.fixtures.BARE)).toBe(g.output.noDocs);
  });
});
