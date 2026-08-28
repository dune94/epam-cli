/**
 * THE VC PROMPTS ARE TEMPLATES.
 *
 * Verification criteria are what every later stage checks an implementation against, so these
 * two prompts decide what "verified" means:
 *
 *   vc-review     flags any criterion that prescribes a MECHANISM. Let one through and
 *                 "verify the behaviour" quietly becomes "verify the approach we guessed at",
 *                 and a correct fix is judged against an implementation nobody required.
 *   vc-regenerate rewrites the criteria once flagged, using the detective's findings.
 *
 * Both branches of each are pinned: a story with no acceptance criteria renders different
 * prose, and that is the branch a bare ticket hits.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/vc-prompts.golden.json');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

describe('the golden capture is real', () => {
  it('matches every digest and the branches differ', () => {
    const g = golden();
    for (const [k, v] of Object.entries(g.output as Record<string, string>)) {
      expect(createHash('sha256').update(v).digest('hex'), k).toBe(g.sha256[k]);
    }
    expect(g.output.reviewFull).not.toBe(g.output.reviewBare);
    expect(g.output.regenFull).not.toBe(g.output.regenBare);
  });
});

describe('both prompts live in the template layer', () => {
  it('the templates exist and declare exactly what they use', () => {
    for (const id of ['vc-review', 'vc-regenerate']) {
      expect(existsSync(T(id)), `${id} missing`).toBe(true);
      const doc = JSON.parse(readFileSync(T(id), 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect([...doc.placeholders].sort(), id).toEqual(used);
    }
  });

  it('vc-review keeps the mechanism rule, which is its whole purpose', () => {
    const body = JSON.parse(readFileSync(T('vc-review'), 'utf8')).body as string;
    expect(body).toMatch(/mechanism|approach/i);
  });

  it('neither names a project or a fixture value', () => {
    for (const id of ['vc-review', 'vc-regenerate']) {
      const body = JSON.parse(readFileSync(T(id), 'utf8')).body as string;
      for (const lit of ['VC_ONE', 'FLAG_ONE', 'SITEBLOCK_S', 'metrolinx', 'contentstack']) {
        expect(body, `${id} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});

describe('the migration changed no bytes', () => {
  it('all four captured prompts reproduce exactly', () => {
    const g = golden();
    const M = require(RUNNER);
    const S = g.fixtures.STORY, N = g.fixtures.NOACS;
    expect(M.buildVcReviewPrompt({ story: S, vc: ['VC_ONE', 'VC_TWO'] })).toBe(g.output.reviewFull);
    expect(M.buildVcReviewPrompt({ story: N, vc: ['VC_ONE'] })).toBe(g.output.reviewBare);
    expect(M.buildVcRegeneratePrompt({ story: S, flags: ['FLAG_ONE'], siteBlock: 'SITEBLOCK_S' }))
      .toBe(g.output.regenFull);
    expect(M.buildVcRegeneratePrompt({ story: N, flags: [], siteBlock: '' })).toBe(g.output.regenBare);
  });
});

describe('the regenerator sees every finding', () => {
  it('the detective findings are no longer capped at five', () => {
    // A SEPARATE change from the migration, made visible rather than folded into it. These
    // are the files and functions the fix must touch, and they are the only reason regenerated
    // criteria are concrete — capping them withheld evidence from the agent whose vagueness
    // the cap was supposed to be fixing.
    const src = readFileSync(RUNNER, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src, 'the findings cap is back').not.toMatch(/findings\.slice\(0,\s*\d+\)/);
  });
});
