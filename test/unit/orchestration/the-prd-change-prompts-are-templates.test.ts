/**
 * THE PRD-CHANGE PROMPTS ARE TEMPLATES.
 *
 * 9 and 10 of the twenty seams, and the first migrations inside claude.sh — the file the
 * writer path runs through.
 *
 * Three prompts: the change reviewer, and the summarizer in its two variants. The variants
 * stayed SEPARATE prompts rather than one prompt with a branch: they instruct differently and
 * their output caps differ (4000 vs 400), so folding them together would hide which one an
 * agent actually received.
 *
 * VALUES GO VIA A FILE, NEVER ARGV. before/after carry whole PRD fragments, and a value past
 * ARG_MAX exits 126 with an empty result — which is precisely how the FailureAnalyst died
 * silently earlier today, with the failure surfacing three steps later as a parse error.
 *
 * The test EXECUTES the rewired shell blocks out of the shipped claude.sh and compares them
 * to a capture taken before the move.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/prd-change.golden.json');
const VERIFY = join(ROOT, 'test/fixtures/prompt-migration/verify-prd-change.sh');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const IDS = ['prd-change-reviewer', 'prd-change-summarizer-tool', 'prd-change-summarizer-text'];

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

/** Run the REAL rewired blocks from the shipped claude.sh. */
function rendered(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'prd-change-'));
  try {
    const res = spawnSync('bash', [VERIFY, SCRIPTS, dir], {
      encoding: 'utf8',
      env: { ...process.env, NODE_BIN: process.execPath },
    });
    const out: Record<string, string> = {};
    for (const [k, f] of [['reviewer', 'reviewer.now'], ['tool', 'tool.now'], ['text', 'text.now']]) {
      const p = join(dir, f);
      out[k] = existsSync(p) ? readFileSync(p, 'utf8') : `__NOT_PRODUCED__ ${res.stderr}`;
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the golden capture is real', () => {
  it('matches every digest', () => {
    const g = golden();
    for (const [k, v] of Object.entries(g.output as Record<string, string>)) {
      expect(createHash('sha256').update(v).digest('hex'), k).toBe(g.sha256[k]);
    }
  });
});

describe('all three prompts live in the template layer', () => {
  it('the templates exist', () => {
    for (const id of IDS) expect(existsSync(T(id)), `${id} missing`).toBe(true);
  });

  it('both seams declare a template', () => {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(r.profiles['prd-change-reviewer']?.template).toBe('prd-change-reviewer');
    expect(r.profiles['prd-change-summarizer']?.template).toBe('prd-change-summarizer-text');
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const id of IDS) {
      const doc = JSON.parse(readFileSync(T(id), 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect([...doc.placeholders].sort(), id).toEqual(used);
    }
  });

  it('the tool variant carries no change type — a bash script is a bash script', () => {
    // Why the variants are separate prompts: they do not take the same inputs, and the
    // renderer rejects a value the template never mentions.
    const doc = JSON.parse(readFileSync(T('prd-change-summarizer-tool'), 'utf8'));
    expect(doc.placeholders).not.toContain('__CHANGE_TYPE__');
    expect(JSON.parse(readFileSync(T('prd-change-summarizer-text'), 'utf8')).placeholders)
      .toContain('__CHANGE_TYPE__');
  });
});

describe('the migration changed no bytes', () => {
  it('the shipped shell reproduces all three captured prompts exactly', () => {
    const g = golden();
    const now = rendered();
    for (const k of ['reviewer', 'tool', 'text']) {
      expect(now[k], `${k} did not render`).not.toMatch(/__NOT_PRODUCED__/);
      expect(now[k], `${k} differs`).toBe(g.output[k]);
    }
  });
});
