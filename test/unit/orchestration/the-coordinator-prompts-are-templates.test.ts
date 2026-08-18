/**
 * THE COORDINATOR PROMPTS ARE TEMPLATES.
 *
 *   spec-coordinator        decides when a phase's specification is DONE, so its wording sets
 *                           the bar every story is admitted against.
 *   spec-coordinator-review reviews a completed pass against manifest evidence and codeline
 *                           scope — both computed from the run's own PRD, so both are VALUES.
 *   spec-model-review       decides which model each story runs on. The two model NAMES arrive
 *                           as values; baking them in would put a model vocabulary back into
 *                           the engine, which the ladder-position work removed a day earlier.
 *
 * All three shared a leading `profile ? profile + '\n\n' : ''` conditional. That is exactly
 * the shape that silently deleted a section during the VC migration, so it is carried as a
 * single value and both of its outcomes are exercised below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const IDS = ['spec-coordinator', 'spec-coordinator-review', 'spec-model-review'];
const { renderEngineTemplate, placeholdersIn } =
  require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

const doc = (id: string) => JSON.parse(readFileSync(T(id), 'utf8'));

describe('all three live in the template layer', () => {
  it('the templates exist', () => {
    for (const id of IDS) expect(existsSync(T(id)), `${id} missing`).toBe(true);
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const id of IDS) {
      expect([...doc(id).placeholders].sort(), id)
        .toEqual([...new Set(placeholdersIn(doc(id).body))].sort());
    }
  });

  it('the profile prefix is a value in every one of them', () => {
    for (const id of IDS) expect(doc(id).placeholders, id).toContain('__PROFILE_PREFIX__');
  });

  it('the model review names no model of its own', () => {
    const body = doc('spec-model-review').body as string;
    expect(body).not.toMatch(/MiniMax|glm-|kimi|claude-/i);
    expect(doc('spec-model-review').placeholders).toContain('__MINI_MODEL__');
    expect(doc('spec-model-review').placeholders).toContain('__UPGRADE_MODEL__');
  });

  it('none names a project or a fixture value', () => {
    for (const id of IDS) {
      const body = doc(id).body as string;
      for (const lit of ['PROFILE_S', 'PAYLOAD_S', 'metrolinx', 'gotransit']) {
        expect(body, `${id} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});

describe('the profile prefix collapses cleanly when absent', () => {
  it('an empty profile leaves no stray blank lines at the top', () => {
    // The conditional both branches must handle: with a profile it is prepended plus two
    // newlines; without one the prompt must start at its own first word.
    for (const id of IDS) {
      const vals = Object.fromEntries(doc(id).placeholders.map((p: string) => [p, p === '__PROFILE_PREFIX__' ? '' : 'x']));
      const out = renderEngineTemplate(id, vals);
      expect(out.startsWith('\n'), `${id} starts with a blank line when no profile is set`).toBe(false);
      expect(out.length).toBeGreaterThan(200);
    }
  });

  it('a present profile is prepended ahead of everything else', () => {
    for (const id of IDS) {
      const vals = Object.fromEntries(doc(id).placeholders.map((p: string) => [p, p === '__PROFILE_PREFIX__' ? 'PERSONA\n\n' : 'x']));
      expect(renderEngineTemplate(id, vals).startsWith('PERSONA\n\n'), id).toBe(true);
    }
  });
});
