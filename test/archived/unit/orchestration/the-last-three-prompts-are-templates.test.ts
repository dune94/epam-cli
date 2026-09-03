/**
 * THE LAST THREE PROMPTS ARE TEMPLATES.
 *
 * 17-20 of the twenty seams, completing the migration:
 *
 *   tc-writer         turns verification criteria into the tests that check them, so its
 *                     wording decides what "verified" means for every story.
 *   code-review-cycle returns the verdict on an implementation.
 *   vc-coverage       decides whether a suite covers ONE criterion — deliberately narrow:
 *                     one requirement, one suite, one yes or no with the covering case named.
 *   repro-test-writer needed NO migration. Its prompt was already in the layer and rendered
 *                     through prompt-library; only the registry LINK was missing, so the seam
 *                     looked migrated while nothing connected it. That near-miss is why the
 *                     checklist is derived from the registry rather than from a text sweep.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/last-three.golden.json');
const VERIFY = join(ROOT, 'test/fixtures/prompt-migration/verify-last-three.sh');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const IDS = ['tc-writer', 'code-review-cycle', 'vc-coverage'];

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

function rendered(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'last3-'));
  try {
    const res = spawnSync('bash', [VERIFY, SCRIPTS, dir], {
      encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath },
    });
    const out: Record<string, string> = {};
    for (const id of IDS) {
      const p = join(dir, `${id}.now`);
      out[id] = existsSync(p) ? readFileSync(p, 'utf8') : `__NOT_PRODUCED__ ${res.stderr}`;
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the golden capture is real', () => {
  it('matches every digest', () => {
    const g = golden();
    for (const id of IDS) {
      expect(createHash('sha256').update(g.output[id]).digest('hex'), id).toBe(g.sha256[id]);
    }
  });
});

describe('all three live in the template layer', () => {
  it('the templates exist and the seams declare them', () => {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    for (const id of IDS) {
      expect(existsSync(T(id)), `${id} missing`).toBe(true);
      expect(r.profiles[id]?.template, `${id} seam not linked`).toBe(id);
    }
  });

  it('repro-test-writer is linked, though its prompt never moved', () => {
    // The near-miss: its prompt was already in the layer, rendered through prompt-library,
    // but the seam declared no template — so it looked migrated and was not connected.
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(r.profiles['repro-test-writer']?.template).toBe('repro-test-writer');
    expect(existsSync(T('repro-test-writer'))).toBe(true);
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const id of IDS) {
      const doc = JSON.parse(readFileSync(T(id), 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect([...doc.placeholders].sort(), id).toEqual(used);
    }
  });

  it('vc-coverage stays narrow — one criterion, one suite', () => {
    const doc = JSON.parse(readFileSync(T('vc-coverage'), 'utf8'));
    expect(doc.placeholders.sort()).toEqual(['__TEST_SOURCE__', '__VERIFICATION_CRITERION__']);
  });

  it('none names a project or a fixture value', () => {
    for (const id of IDS) {
      const body = JSON.parse(readFileSync(T(id), 'utf8')).body as string;
      for (const lit of ['STORYID_S', 'REVPROFILE_S', 'metrolinx', 'gotransit']) {
        expect(body, `${id} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});

describe('the migration changed no bytes', () => {
  it('the shipped shell reproduces all three exactly', () => {
    const g = golden();
    const now = rendered();
    for (const id of IDS) {
      expect(now[id], `${id} did not render`).not.toMatch(/__NOT_PRODUCED__/);
      expect(now[id], `${id} differs`).toBe(g.output[id]);
    }
  });
});
