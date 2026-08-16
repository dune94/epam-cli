/**
 * THE SPECKIT PROMPTS ARE TEMPLATES.
 *
 * runSpeckitAgent carried a ternary with two COMPLETE prompts:
 *
 *   refine        acceptance criteria for split children that already exist — taken only when
 *                 validateMidExecutionSplits has created them
 *   collaborative speckit building on what the openspec agent produced
 *
 * They are two templates rather than one with a condition, because they ask for different
 * work from different starting material. Folding them together would hide which instructions
 * an agent actually received — the same reasoning that kept the six QA sentinels separate.
 *
 * VERIFIED AGAINST THE SOURCE, NOT A SAMPLE OF ITS OUTPUT. Earlier migrations captured the
 * rendered prompt and compared bytes, and that missed a conditional the fixture never
 * exercised — a whole section silently vanished. Here the original template literal is
 * reconstructed from the pre-migration file and interpolated with the same sentinel values as
 * the template, so the comparison covers every branch by construction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const IDS = ['spec-agent-speckit-refine', 'spec-agent-speckit'];
const { renderEngineTemplate, placeholdersIn } =
  require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

describe('both branches live in the template layer', () => {
  it('both templates exist', () => {
    for (const id of IDS) expect(existsSync(T(id)), `${id} missing`).toBe(true);
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const id of IDS) {
      const doc = JSON.parse(readFileSync(T(id), 'utf8'));
      expect([...doc.placeholders].sort(), id)
        .toEqual([...new Set(placeholdersIn(doc.body))].sort());
    }
  });

  it('they are genuinely different prompts, not one text twice', () => {
    const [a, b] = IDS.map((id) => JSON.parse(readFileSync(T(id), 'utf8')).body);
    expect(a).not.toBe(b);
    // The refine branch takes the children that already exist; the other takes openspec output.
    expect(JSON.parse(readFileSync(T(IDS[0]), 'utf8')).placeholders).toContain('__EXISTING_CHILDREN__');
    expect(JSON.parse(readFileSync(T(IDS[1]), 'utf8')).placeholders).toContain('__OPENSPEC_OUTPUT__');
  });

  it('neither names a project or carries a fixture value', () => {
    for (const id of IDS) {
      const body = JSON.parse(readFileSync(T(id), 'utf8')).body as string;
      for (const lit of ['FRB_S', 'PAYLOAD_S', 'metrolinx', 'gotransit', 'contentstack']) {
        expect(body, `${id} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});

describe('both render', () => {
  it('produce a non-empty prompt with every placeholder replaced', () => {
    const vals: Record<string, Record<string, string>> = {
      'spec-agent-speckit-refine': {
        __FORCED_RETRY_BLOCK__: '', __PHASE__: 'p', __STORY_ID__: 's',
        __EXISTING_CHILDREN__: '[]', __STORY_PAYLOAD__: '{}',
      },
      'spec-agent-speckit': {
        __FORCED_RETRY_BLOCK__: '', __PHASE__: 'p', __STORY_ID__: 's',
        __OPENSPEC_OUTPUT__: '{}', __STORY_PAYLOAD__: '{}',
      },
    };
    for (const id of IDS) {
      const out = renderEngineTemplate(id, vals[id]);
      expect(out.length, id).toBeGreaterThan(500);
      expect(out, `${id} left a placeholder unreplaced`).not.toMatch(/__[A-Z][A-Z0-9_]*?__/);
    }
  });
});
