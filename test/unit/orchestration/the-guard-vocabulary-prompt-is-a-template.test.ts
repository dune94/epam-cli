/**
 * THE GUARD-VOCABULARY PROMPT IS A TEMPLATE.
 *
 * 4 of the twenty seams, and the most section-heavy so far: persona, documentation, evidence
 * and a CodeGraph verify block, each present or absent independently.
 *
 * The terms this prompt returns feed a BM25/IDF ranker, which DEMOTES common terms and
 * AMPLIFIES rare ones — so a rare meaningless token is promoted to a top discriminator and
 * drags the search away from real code. The prompt's job is to stop that, and its wording is
 * the whole mechanism.
 *
 * TWO DEFECTS THE BYTE CHECK CAUGHT, both invisible to a reading:
 *   - a newline placed in the parent instead of the section produced a blank line in exactly
 *     the branch where no index exists — the case least likely to be looked at
 *   - templating the documentation HEADING alone silently dropped five lines carrying the
 *     rule that a vendor-published name describing observable behaviour must not be flagged.
 *     A guard that lost that would have started flagging every documented name it saw.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/guard-vocabulary.golden.json');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));
const IDS = ['guard-vocabulary', 'guard-vocabulary-documentation', 'guard-vocabulary-codegraph'];

describe('the golden capture is real', () => {
  it('matches its digests, and the branches differ substantially', () => {
    const g = golden();
    expect(createHash('sha256').update(g.output.full).digest('hex')).toBe(g.sha256.full);
    expect(createHash('sha256').update(g.output.bare).digest('hex')).toBe(g.sha256.bare);
    // Four sections drop out, so the bare prompt is much shorter — if these were close, the
    // fixture would not be exercising the conditionals.
    expect(g.output.full.length).toBeGreaterThan(g.output.bare.length * 2);
  });
});

describe('the prompt and its fragments live in the template layer', () => {
  it('all three templates exist', () => {
    for (const id of IDS) expect(existsSync(T(id)), `${id} missing`).toBe(true);
  });

  it('the seam declares the parent', () => {
    expect(JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles['guard-vocabulary']?.template)
      .toBe('guard-vocabulary');
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const id of IDS) {
      const doc = JSON.parse(readFileSync(T(id), 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect([...doc.placeholders].sort(), `${id} placeholder mismatch`).toEqual(used);
    }
  });

  it('the documentation fragment keeps the vendor-name rule, not just the heading', () => {
    const body = JSON.parse(readFileSync(T('guard-vocabulary-documentation'), 'utf8')).body as string;
    expect(body).toMatch(/OBSERVABLE behaviour/);
    expect(body).toMatch(/implementation detail wearing a published name/);
  });

  it('none carries a sentinel or a project fact', () => {
    for (const id of IDS) {
      const body = JSON.parse(readFileSync(T(id), 'utf8')).body as string;
      for (const lit of ['PERSONA_S', 'RULE_S', 'DOCBLOCK_S', 'REPO_S', 'metrolinx', 'contentstack']) {
        expect(body, `${id} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});

describe('the migration changed no bytes', () => {
  const build = () => require(RUNNER).buildGuardVocabularyPrompt;

  it('reproduces the fully-populated prompt exactly', () => {
    const g = golden();
    expect(build()(g.fixtures.FULL)).toBe(g.output.full);
  });

  it('reproduces the bare prompt exactly — every section collapses to nothing', () => {
    const g = golden();
    const out = build()(g.fixtures.BARE);
    expect(out).toBe(g.output.bare);
    // The specific regression: a parent-supplied newline left a blank line here.
    expect(out).not.toMatch(/\n\n\n/);
  });
});
