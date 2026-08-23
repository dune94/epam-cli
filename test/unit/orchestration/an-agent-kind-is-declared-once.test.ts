/**
 * WHAT KINDS OF AGENT EXIST IS DECLARED ONCE, AS DATA.
 *
 * Two modules held the answer as a literal, and they disagreed:
 *
 *   project-roster.js:85   const KINDS       = ['implementer', 'investigator', 'seam'];
 *   agent-roster.js:67     const AGENT_KINDS = ['implementer', 'investigator'];
 *
 * One concept, two definitions, different contents. A roster entry of kind "seam" validates in one
 * and is an "unrecognised kind" in the other, and which answer a run gets depends on which module
 * happened to look. Adding a kind means editing engine code in two places and hoping both are
 * found.
 *
 * The registry already declares it: `seamPatterns[].kind` is what src/scaffold/seamVocabulary.ts
 * derives the mint's naming rule from. So the lists were hardcoded copies of derivable data —
 * ordinary hardcoding, in the place that decides whether an agent may own a story.
 *
 * These tests hold both modules to the registry, and to each other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

/**
 * What the registry itself declares — the one source both modules must answer from.
 *
 * `agentKinds`, not the kinds appearing on seamPatterns: those name-shape rules cover the kinds
 * that own stories, and 'seam' is a kind no naming rule mentions. Deriving from them would have
 * silently narrowed the vocabulary and rejected every seam agent in the roster.
 */
const declared = (): string[] => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  return [...new Set((reg.agentKinds || []) as string[])].sort();
};

describe('the kinds come from the registry, not from a literal', () => {
  it('the registry declares the kinds — otherwise this suite proves nothing', () => {
    expect(declared().length).toBeGreaterThan(0);
  });

  it('and the kind the two modules disagreed over is among them', () => {
    // 'seam' is the one that validated in project-roster and was "unrecognised" in agent-roster.
    expect(declared()).toContain('seam');
  });

  it('project-roster answers from the registry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { agentKinds } = require(join(LIB, 'project-roster.js'));
    expect(typeof agentKinds, 'project-roster exposes no derived kinds').toBe('function');
    expect(agentKinds().slice().sort()).toEqual(declared());
  });

  it('agent-roster answers from the registry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { agentKinds } = require(join(LIB, 'agent-roster.js'));
    expect(typeof agentKinds, 'agent-roster exposes no derived kinds').toBe('function');
    expect(agentKinds().slice().sort()).toEqual(declared());
  });

  it('and the two agree — the divergence that existed cannot recur', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const a = require(join(LIB, 'project-roster.js')).agentKinds().slice().sort();
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const b = require(join(LIB, 'agent-roster.js')).agentKinds().slice().sort();
    expect(a).toEqual(b);
  });

  it('neither module still carries a hardcoded list', () => {
    for (const f of ['project-roster.js', 'agent-roster.js']) {
      const code = readFileSync(join(LIB, f), 'utf8').split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      expect(code, `${f} still declares kinds as a literal`)
        .not.toMatch(/=\s*\[\s*'implementer'\s*,\s*'investigator'/);
    }
  });
});
