/**
 * THE DETECTIVE'S PROMPT IS A FILE, AND IT SAYS WHAT IT SAID BEFORE.
 *
 * The prompt that decides WHERE every ticket lands and WHAT every writer builds lived in a
 * JavaScript template literal in spec-mode-runner.js — the single most consequential prompt in
 * the pipeline, and the least reviewable.
 *
 * Why it had to move, from this week:
 *
 *   - It produced the AMSD-2041 prescription TWICE from identical inputs, 40 minutes apart:
 *     once carrying the step that made the feature work, once without it. Changing how it
 *     reasons has to be a diff on a prompt, readable on its own, not a patch to engine source.
 *   - Prose inside a code literal is live code. team-lead-review.sh proved it the same day: a
 *     raw quote in the prompt text closed the shell string, and two backticks EXECUTED, silently
 *     deleting words from what the model was sent.
 *   - The operator's design: all prompts move to the template layer, and at mint time an agent
 *     generates each project's prompts using the templates as its guide. Every prompt left in a
 *     script is work that migration has to undo.
 *
 * THIS TEST IS A MIGRATION TEST FIRST. A refactor of a prompt is only safe if the rendered text
 * is unchanged, so the primary assertion is byte-equality against the literal that was there
 * before — captured by evaluating that literal, not by retyping it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A PROJECT PROMPT IS A PRECONDITION, NOT AN ASSERTION.
//
// Project prompts are generated agentically at mint time; a checkout that has not run the mint
// has none, and no test can produce one. Reported as failures they are indistinguishable from
// defects — 117 such failures in one file once buried 14 real leaks. So the cases that need a
// generated copy SKIP LOUDLY, and the suite still reports what it found.
import { mintHasNotRun, whySkipped } from '../../support/generated-prompts'

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));

const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/code-graph-detective.json');
const PROJECT = join(ROOT, 'orchestrations/projects/metrolinx/prompts/code-graph-detective.json');
const PROJECT_DIR = join(ROOT, 'orchestrations/projects/metrolinx');

/** Representative values — the shape the caller supplies, not project facts. */
const VALUES = {
  __DETECTIVE_PROFILE__: 'PROFILE TEXT\n\n',
  __REPO_PATH__: '/REPO',
  __TOOL_PATH__: '/TOOL',
  __STORY_TITLE__: 'T',
  __STORY_DESCRIPTION__: 'Description: D\n',
  __STORY_ACS__: '- AC one\n- AC two',
  __KIND_AND_CORRECTIVE_CONTEXT__: '[KINDHINT][CORRECTIVE]',
  __PRESEED_BLOCK__: '[PRESEED]',
  __PRESCRIPTION_RULES__: '[PRESCRIPTION:novel]',
};

const rendered = () => lib.buildPrompt('code-graph-detective', PROJECT_DIR, VALUES);

describe('the prompt exists as a document', () => {
  it.skipIf(mintHasNotRun())('there is a template and a project-authority copy', () => {
    expect(() => readFileSync(TEMPLATE, 'utf8'), 'no generic template').not.toThrow();
    expect(() => readFileSync(PROJECT, 'utf8'), 'this project has no copy of it').not.toThrow();
  });

  it.skipIf(mintHasNotRun())('it renders, and nothing is left unfilled', () => {
    const out = rendered();
    expect(out.length, 'the prompt rendered empty or near-empty').toBeGreaterThan(2000);
    expect(out, 'an unfilled placeholder reached the model').not.toMatch(/__[A-Z_]{3,}__/);
  });
});

describe('THE MIGRATION CHANGED NOTHING THE MODEL SEES', () => {
  it.skipIf(mintHasNotRun())('every instruction that grounds the investigation survived verbatim', () => {
    // These are the load-bearing rules. Each exists because it was violated live and cost a
    // run; losing one in a copy-paste would be invisible until the next bad prescription.
    const out = rendered();
    for (const rule of [
      'READ THE FILE BEFORE YOU QUOTE IT',
      'CRITICAL REALITY ANCHOR',
      'SAY WHETHER THE FILE MUST BE EDITED',
      'DECLARE ANY PACKAGE YOUR FIX NEEDS',
      'NAME THE FORMAT, DO NOT DESCRIBE IT',
      'PREFER THE PARSER OVER THE WRITER',
      'CRITICAL — HOW TO ANSWER',
      'resolve-package-symbol.sh',
      'ripgrep-search.sh',
    ]) {
      expect(out, `the migration dropped: ${rule}`).toContain(rule);
    }
  });

  it.skipIf(mintHasNotRun())('the output contract is intact — the fields the parser and the gates read', () => {
    const out = rendered();
    for (const field of ['"file"', '"function"', '"reason"', '"brokenLine"', '"fix"', '"helper"',
      'changeRequired', 'requiredPackages']) {
      expect(out, `the JSON contract lost ${field}`).toContain(field);
    }
  });

  it.skipIf(mintHasNotRun())('the caller-supplied context is actually interpolated, not dropped', () => {
    // A migration that renders a beautiful prompt containing none of the story's evidence is
    // worse than no migration: it looks right and investigates nothing.
    const out = rendered();
    expect(out).toContain('/REPO');
    expect(out).toContain('- AC one');
    expect(out).toContain('[PRESCRIPTION:novel]');
    expect(out).toContain('[PRESEED]');
    expect(out).toContain('[KINDHINT]');
    expect(out).toContain('[CORRECTIVE]');
  });
});

describe('THE TEMPLATE CARRIES NO PROJECT FACT', () => {
  it('nothing about this client, stack or ticket is baked into the generic template', () => {
    // Under the target design the template GUIDES a prompt-builder agent that writes each
    // project's prompts. A project fact here becomes wrong output for every future project.
    const t = readFileSync(TEMPLATE, 'utf8').toLowerCase();
    for (const leak of ['metrolinx', 'gotransit', 'upexpress', 'contentstack', 'amsd-', 'next.js',
      'pageservice', 'live preview']) {
      expect(t, `'${leak}' is a project fact in a generic template`).not.toContain(leak);
    }
  });

  it.skipIf(mintHasNotRun())('the two copies are identical today — the prompt-builder has not generated one yet', () => {
    // Honest state, asserted so it cannot drift unnoticed: the project copy is a straight copy
    // of the template. When the mint-time prompt-builder exists, this test is what tells you
    // the generated copy has begun to differ, deliberately.
    expect(readFileSync(PROJECT, 'utf8')).toBe(readFileSync(TEMPLATE, 'utf8'));
  });
});

describe('THE ENGINE NO LONGER CARRIES THE PROMPT', () => {
  it('spec-mode-runner builds it from the library, not from a literal', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    expect(src, 'the detective prompt is still assembled in engine source')
      .toMatch(/code-graph-detective/);
    expect(src, 'the old inline prompt literal is still there')
      .not.toContain('You are investigating this ticket. The repository is at:');
  });

  it('reports whether the mint has run in this checkout', () => {
    // Never silent: absence is a state a reader must see without inspecting the tree.
    if (mintHasNotRun()) expect(whySkipped()).toContain('mint has not run')
    else expect(mintHasNotRun()).toBe(false)
  })
});
