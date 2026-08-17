/**
 * A GENERATED PROMPT SERVES THE SEAM ITS TEMPLATE DECLARES — OR IT SERVES NOTHING.
 *
 * The prompt library is joined to the roster by seam: prompt-agent-link asks, for each minted
 * agent, whether any installed prompt declares the seam that agent enters at. A generated copy
 * that loses or rewrites `seams` is invisible to that join, and every agent at that seam looks
 * unprovisioned.
 *
 * Live 2026-08-17, run 20260817T211517Z. Provisioning COMPLETED — 37 prompts, the furthest any run
 * had reached — and then:
 *
 *   [prompt-link] 2 minted agent(s) enter at a seam this project has no prompt for
 *     gate-finding-analyst  ->  seam 'impl-failure-analyst'  ->  no installed prompt declares it
 *     failure-analyst       ->  seam 'impl-failure-analyst'  ->  no installed prompt declares it
 *
 * The linker was right. The installed copy said seams: ["failure-analyst"] where its template says
 * ["impl-failure-analyst"].
 *
 * ONE of 37 prompts drifted, because for the other 36 the seam name equals the template id — the
 * same rewrite is invisible there. failure-analyst is the only template where they differ, which
 * is exactly the shape that survives every test written against a convenient example.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildGeneratedDoc } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));

const templates = () => readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8')));

const bodyOf = (t: any) => (typeof t.body === 'string' && t.body
  ? t.body
  : Object.values(t.bodies || {}).filter((v) => typeof v === 'string').join('\n'));

describe('a generated prompt must keep its seams', () => {
  it('EVERY template keeps its declared seams through generation', () => {
    const drifted: string[] = [];
    let checked = 0;
    for (const t of templates()) {
      if (!Array.isArray(t.seams) || !t.seams.length) continue;
      checked += 1;
      const doc = buildGeneratedDoc(t, bodyOf(t));
      if (JSON.stringify(doc.seams) !== JSON.stringify(t.seams)) {
        drifted.push(`${t.id}: template=${JSON.stringify(t.seams)} generated=${JSON.stringify(doc.seams)}`);
      }
    }
    expect(checked, 'no template declares a seam — the sweep found nothing to check')
      .toBeGreaterThan(10);
    expect(drifted, `generated copies serve a seam their template does not:\n${drifted.join('\n')}`)
      .toEqual([]);
  });

  it('THE CASE THAT BROKE IT: a seam name that differs from the template id', () => {
    // 36 of 37 templates hide this because seam === id. Assert the one that does not.
    const t = templates().find((x) => Array.isArray(x.seams) && x.seams.some((s: string) => s !== x.id));
    expect(t, 'no template has a seam name differing from its id — this test now proves nothing')
      .toBeTruthy();
    const doc = buildGeneratedDoc(t, bodyOf(t));
    expect(doc.seams).toEqual(t.seams);
    expect(doc.seams, 'the seams were rewritten to the template id').not.toEqual([t.id]);
  });

  it('a generated copy always carries a real provenance digest', () => {
    // The installed copy carried derivedFromSha256: "" — a value this function cannot produce,
    // which is the clue that something other than a clean generation wrote it.
    const t = templates().find((x) => Array.isArray(x.seams) && x.seams.length)!;
    const doc = buildGeneratedDoc(t, bodyOf(t));
    expect(String(doc.derivedFromSha256), 'a generated prompt has no provenance').toMatch(/^[0-9a-f]{64}$/);
  });
});
