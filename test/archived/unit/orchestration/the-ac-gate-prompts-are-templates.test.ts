/**
 * THE AC-GATE PROMPTS ARE TEMPLATES.
 *
 * 5 and 6 of the twenty seams, both living in lib/ac-gate.js.
 *
 *   ac-classification — decides whether a story can be implemented without a human, and which
 *                       codeline it belongs to, including whether it must be SPLIT across
 *                       several. Every codeline-shaped block is assembled from the run's own
 *                       registered codelines, so the template can name none.
 *   ac-elaboration    — runs when a story has NO acceptance criteria, so what it writes
 *                       becomes the contract every later stage verifies against.
 *
 * The empty branch is pinned as well as the populated one: a story with no ACs and no
 * registered codelines renders different prose, and that is the branch that runs on a fresh
 * ticket.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/ac-gate.golden.json');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const MODULE = join(ROOT, 'orchestrations/scripts/lib/ac-gate.js');

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));
const IDS = ['ac-classification', 'ac-elaboration'];

describe('the golden capture is real', () => {
  it('matches every digest', () => {
    const g = golden();
    for (const [k, v] of Object.entries(g.output as Record<string, string>)) {
      expect(createHash('sha256').update(v).digest('hex'), k).toBe(g.sha256[k]);
    }
  });

  it('the populated and empty classifications differ', () => {
    const g = golden();
    expect(g.output.classifyFull).not.toBe(g.output.classifyBare);
  });
});

describe('both prompts live in the template layer', () => {
  it('the templates exist and both seams declare them', () => {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    for (const id of IDS) {
      expect(existsSync(T(id)), `${id} missing`).toBe(true);
      expect(r.profiles[id]?.template, `${id} seam not linked`).toBe(id);
    }
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const id of IDS) {
      const doc = JSON.parse(readFileSync(T(id), 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect([...doc.placeholders].sort(), id).toEqual(used);
    }
  });

  it('the classification template names no codeline of its own', () => {
    // It could not name one and stay correct for a project with different codelines.
    const body = JSON.parse(readFileSync(T('ac-classification'), 'utf8')).body as string;
    for (const lit of ['cl-one', 'cl-two', 'metrolinx', 'gotransit', 'upexpress']) {
      expect(body, `hardcodes '${lit}'`).not.toContain(lit);
    }
  });

  it('the elaboration template keeps rule 6 — WHAT to verify, never HOW', () => {
    // The load-bearing rule: prescribing a mechanism misdirects the whole downstream
    // code investigation.
    const body = JSON.parse(readFileSync(T('ac-elaboration'), 'utf8')).body as string;
    expect(body).toMatch(/observable behavior|OBSERVABLE/i);
    expect(body).toMatch(/never HOW to implement/i);
  });
});

describe('the migration changed no bytes', () => {
  it('all three captured prompts reproduce exactly', () => {
    const g = golden();
    const { buildClassificationPrompt: C, buildElaborationPrompt: E } = require(MODULE);
    expect(C(g.fixtures.ISSUE, g.fixtures.CODELINES)).toBe(g.output.classifyFull);
    expect(C(g.fixtures.NOACS, [])).toBe(g.output.classifyBare);
    expect(E(g.fixtures.ISSUE)).toBe(g.output.elaborate);
  });

  it('the module can be required without running the gate', () => {
    expect(typeof require(MODULE).buildClassificationPrompt).toBe('function');
  });
});
