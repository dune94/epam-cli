/**
 * EVERY ARCHETYPE DECLARES WHAT IT PRODUCES AND WHAT IT CONSUMES.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Today an archetype declares only how to INVOKE it — ladder, effort, tools, timeout. Nothing
 * says what it makes or what it needs, so every consumer works that out for itself by reaching
 * into another agent's data: seven scripts know the investigator's field names.
 *
 * With produces/consumes on the archetype, the wiring becomes DATA:
 *
 *   code-graph-detective  produces fix-plan        consumes ticket, codeline-facts
 *   story-writer          produces implementation  consumes fix-plan (required), review-feedback…
 *   team-lead-review      produces review-feedback consumes implementation (required), fix-plan…
 *
 * A minted instance inherits its archetype's declaration, so a minted investigator feeding a
 * minted writer needs no wiring anywhere — which is the whole point.
 *
 * TWO RULES THIS FILE ENFORCES, both of which prevent a class of live defect:
 *
 *   NOTHING CONSUMES WHAT NOBODY PRODUCES. A consumer waiting forever for an input nobody makes
 *   is the shape of every unwinnable story this pipeline has produced. It is checkable from the
 *   data alone, with no model involved.
 *
 *   NO PROJECT FACT IN THE REGISTRY. Under the prompt-builder design a mint-time agent generates
 *   project prompts from these archetypes; a client name here becomes wrong output for every
 *   other project — the same rule the templates are already held to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');

const reg = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));
const profiles = () => reg().profiles as Record<string, any>;

describe('the registry still describes how to invoke', () => {
  it('archetypes exist and keep their invocation settings', () => {
    // Guards against a rewrite that adds the new fields and loses the old ones.
    const p = profiles();
    expect(Object.keys(p).length).toBeGreaterThan(10);
    for (const [name, v] of Object.entries(p)) {
      expect(v.ladder || v.reasoningEffort, `${name} lost its invocation settings`).toBeTruthy();
    }
  });
});

describe('EVERY ARCHETYPE SAYS WHAT IT MAKES', () => {
  it('each declares a produces kind', () => {
    for (const [name, v] of Object.entries(profiles())) {
      expect(typeof v.produces, `${name} does not declare what it produces`).toBe('string');
      expect(String(v.produces).length, `${name} produces an empty kind`).toBeGreaterThan(0);
    }
  });

  it('kinds are generic — no project, client or vendor name', () => {
    // A kind named for a client cannot be reused, and the prompt-builder would emit it verbatim
    // into every other project's prompts.
    const projectNames = readdirSync(join(ROOT, 'orchestrations/projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase());
    for (const [name, v] of Object.entries(profiles())) {
      const kinds = [String(v.produces || ''), ...(v.consumes || []).map((c: any) => String(c.kind || ''))];
      for (const k of kinds) {
        for (const p of projectNames) {
          expect(k.toLowerCase(), `${name} declares a kind naming project '${p}'`).not.toContain(p);
        }
      }
    }
  });
});

describe('EVERY ARCHETYPE SAYS WHAT IT NEEDS', () => {
  it('each declares a consumes list', () => {
    for (const [name, v] of Object.entries(profiles())) {
      expect(Array.isArray(v.consumes), `${name} does not declare what it consumes`).toBe(true);
    }
  });

  it('each consumed input names a kind, and says whether it is required', () => {
    for (const [name, v] of Object.entries(profiles())) {
      for (const c of v.consumes || []) {
        expect(typeof c.kind, `${name} consumes an entry with no kind`).toBe('string');
        expect(['boolean', 'undefined'], `${name}: '${c.kind}' has a non-boolean required`)
          .toContain(typeof c.required);
      }
    }
  });
});

describe('NOTHING CONSUMES WHAT NOBODY PRODUCES', () => {
  it('every consumed kind has a producer — an agent, or the engine', () => {
    // The check that makes an unwinnable story impossible to configure: a writer that waits for
    // a plan nobody makes is caught here, deterministically, with no model involved.
    const r = reg();
    const produced = new Set<string>([
      ...Object.values(r.profiles as Record<string, any>).map((v) => String(v.produces)),
      ...((r.engineProduces || []) as string[]),
    ]);
    const orphans: string[] = [];
    for (const [name, v] of Object.entries(r.profiles as Record<string, any>)) {
      for (const c of v.consumes || []) {
        if (!produced.has(String(c.kind))) orphans.push(`${name} consumes '${c.kind}'`);
      }
    }
    expect(orphans, `nothing produces:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('the engine declares the kinds IT produces, rather than them being assumed', () => {
    // Ticket text, file contents and attempt evidence come from the engine, not an agent. They
    // travel the same channel — one mechanism, or they drift, which is how the writer got the
    // attempt diffstat and the reviewer did not.
    expect(Array.isArray(reg().engineProduces),
      'the engine publishes inputs but declares none, so the check above cannot be complete')
      .toBe(true);
  });
});

describe('A DECLARED TEMPLATE MUST EXIST', () => {
  it('every archetype naming a template points at a real one', () => {
    for (const [name, v] of Object.entries(profiles())) {
      if (!v.template) continue;
      const f = join(TEMPLATES, `${v.template}.json`);
      expect(existsSync(f), `${name} names template '${v.template}', which does not exist`).toBe(true);
    }
  });

  it('reports how many archetypes still have no template', () => {
    // Not a failure: only five prompts have been migrated so far. This makes the remaining work
    // visible instead of letting "no template" look like "nothing to do".
    const without = Object.entries(profiles()).filter(([, v]) => !v.template).map(([k]) => k);
    // eslint-disable-next-line no-console
    console.log(`archetypes without a template yet: ${without.length}/${Object.keys(profiles()).length}`);
    expect(without.length).toBeLessThanOrEqual(Object.keys(profiles()).length);
  });
});
