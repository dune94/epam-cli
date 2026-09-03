/**
 * THE ESTATE-SURVEY PROMPT IS A TEMPLATE.
 *
 * First of the twenty seams that still invoke a model from a prompt embedded in code.
 * every-agent-resolves-to-a-prompt.test.ts is the checklist; this is one entry coming green.
 *
 * A MIGRATION IS A MOVE, NOT AN EDIT. This prompt decides which codelines are in scope and
 * which investigators get minted, so a reworded sentence changes the roster and therefore
 * every later stage. The golden file was captured MECHANICALLY from the shipped function
 * before anything moved, and these tests assert the new path reproduces it byte for byte.
 *
 * Both branches are pinned. The prompt has conditional sections — documents and declared
 * dependencies appear only when there are any — and an empty estate renders different prose
 * from a populated one. Pinning only the populated case would let the empty branch rot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/estate-survey.golden.json');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/estate-survey.json');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('the golden capture is real', () => {
  it('holds both branches and their digests', () => {
    const g = golden();
    expect(g.output.full.length).toBeGreaterThan(1000);
    expect(g.output.bare.length).toBeGreaterThan(1000);
    expect(sha(g.output.full)).toBe(g.sha256.full);
    expect(sha(g.output.bare)).toBe(g.sha256.bare);
  });

  it('the two branches genuinely differ, or the bare case proves nothing', () => {
    const g = golden();
    expect(g.output.full).not.toBe(g.output.bare);
  });
});

describe('the prompt now lives in the template layer', () => {
  it('the template exists', () => {
    expect(existsSync(TEMPLATE), 'estate-survey is still embedded in spec-mode-runner.js').toBe(true);
  });

  it('the seam declares it', () => {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(r.profiles['estate-survey']?.template).toBe('estate-survey');
  });

  it('the template names no project, stack or codeline of its own', () => {
    const body = JSON.parse(readFileSync(TEMPLATE, 'utf8')).body as string;
    for (const lit of ['metrolinx', 'gotransit', 'upexpress', 'contentstack', 'alpha', 'beta', 'pkg-one']) {
      expect(body, `the template hardcodes '${lit}'`).not.toContain(lit);
    }
  });

  it('declares exactly the placeholders its body uses', () => {
    const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
    expect([...doc.placeholders].sort()).toEqual(used);
  });
});

describe('the migration changed no bytes', () => {
  const build = () => require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js')).buildSurveyPrompt;

  it('reproduces the populated estate exactly', () => {
    const g = golden();
    expect(build()(g.fixtures.FULL)).toBe(g.output.full);
  });

  it('reproduces the empty estate exactly — the conditional sections still collapse', () => {
    const g = golden();
    expect(build()(g.fixtures.BARE)).toBe(g.output.bare);
  });
});
