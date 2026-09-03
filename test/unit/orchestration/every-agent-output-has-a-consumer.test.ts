/**
 * AN AGENT CALL WHOSE ANSWER NOBODY READS IS A CALL THAT SHOULD NOT BE MADE.
 *
 * The registry could say what a seam PRODUCES, what a seam CONSUMES, and what the ENGINE produces
 * — but had no way to say what the engine CONSUMES. The orchestrator parses most agent answers
 * inline (topology is read straight out of the router's reply with jq at
 * run-agent-orchestration.sh, and codeline-selection is read back as codeline-discovery.json), so
 * twenty-one artefacts appeared to have no consumer at all.
 *
 * That mattered because the graph is what an audit reads. Asked "does resuming lose an input a
 * later agent needs", these declarations answer "nothing consumes anything" — an audit driven by
 * them would certify a pipeline that drops outputs on the floor.
 *
 * So: every artefact a seam produces must be accounted for. Consumed by another seam, or declared
 * in engineConsumes WITH THE FILES THAT READ IT — a declaration that cannot outlive the code it
 * describes — or named in _unconsumedOutputs, which is the defect list and may not grow.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const REGISTRY = JSON.parse(readFileSync(
  join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (/\.(js|sh)$/.test(e)) acc.push(p);
  }
  return acc;
}
const SRC = sources(SCRIPTS).map((f) => ({ f: f.replace(`${ROOT}`, ''), text: readFileSync(f, 'utf8') }));

const PROFILES: Record<string, any> = REGISTRY.profiles;
const PRODUCED = [...new Set(Object.values(PROFILES).map((p: any) => p.produces).filter(Boolean))].sort();
const SEAM_CONSUMED = new Set<string>();
for (const p of Object.values<any>(PROFILES)) {
  for (const c of (p.consumes || [])) SEAM_CONSUMED.add(typeof c === 'string' ? c : c.kind);
}
const ENGINE: Record<string, any> = REGISTRY.engineConsumes || {};
const UNCONSUMED: string[] = REGISTRY._unconsumedOutputs || [];

describe('the graph is real enough to audit', () => {
  it('seams produce artefacts and the registry declares consumers', () => {
    expect(PRODUCED.length, 'no seam produces anything — the scan is broken').toBeGreaterThan(10);
    expect(Object.keys(ENGINE).length + SEAM_CONSUMED.size,
      'nothing is declared as consumed anywhere').toBeGreaterThan(10);
  });
});

describe('EVERY artefact a seam produces is accounted for', () => {
  it('consumed by a seam, declared as engine-consumed, or named on the defect list', () => {
    const unaccounted = PRODUCED.filter(
      (a) => !SEAM_CONSUMED.has(a) && !(a in ENGINE) && !UNCONSUMED.includes(a));
    expect(unaccounted,
      'a seam produces this and nothing says who reads it — the graph cannot answer whether '
      + 'resuming, or any other change, drops it')
      .toEqual([]);
  });
});

describe('an engineConsumes declaration cannot outlive the code it describes', () => {
  it('every declared reader file exists and really references the artefact', () => {
    const broken: string[] = [];
    for (const [kind, decl] of Object.entries<any>(ENGINE)) {
      const token = decl.readsAs || kind;
      for (const f of (decl.readBy || [])) {
        const hit = SRC.find((s) => s.f === f || s.f.endsWith(f));
        if (!hit) { broken.push(`${kind}: ${f} no longer exists`); continue; }
        if (!hit.text.includes(token)) broken.push(`${kind}: ${f} no longer mentions '${token}'`);
      }
    }
    expect(broken, 'an engine-consumes claim is stale — the reader changed and the graph did not')
      .toEqual([]);
  });

  it('every declaration names at least one reader', () => {
    const empty = Object.entries<any>(ENGINE)
      .filter(([, d]) => !Array.isArray(d.readBy) || d.readBy.length === 0)
      .map(([k]) => k);
    expect(empty, 'declared as engine-consumed with no evidence, which is just an assertion')
      .toEqual([]);
  });
});

describe('the unconsumed list is a ratchet, not a parking space', () => {
  it('does not grow beyond what was measured when it was written', () => {
    // Ten agent calls whose answers nothing reads. Each is spend with no consumer. The number may
    // fall — by finding the consumer or stopping the call — and must never rise silently.
    expect(UNCONSUMED.length,
      `unconsumed agent output rose to ${UNCONSUMED.length}: ${UNCONSUMED.join(', ')}`)
      .toBeLessThanOrEqual(10);
  });

  it('every entry on it is genuinely produced by a seam', () => {
    const bogus = UNCONSUMED.filter((a) => !PRODUCED.includes(a));
    expect(bogus, 'the defect list names something no seam produces').toEqual([]);
  });
});
