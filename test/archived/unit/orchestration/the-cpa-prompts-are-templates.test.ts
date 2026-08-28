/**
 * THE CPA PROMPTS ARE TEMPLATES.
 *
 * 7 and 8 of the twenty seams.
 *
 *   cpa-inference — the per-story envelope. Mostly DATA (story, formula baseline, KB sources,
 *                   code signals, adjacent stories, manifest, the detective's fix sites), so
 *                   what is genuinely prompt is the envelope and the closing instruction.
 *   cpa-system    — the estimator's standing instructions. It was a QUOTED heredoc, carrying
 *                   no interpolation at all: the simplest possible case of a prompt with no
 *                   business living in a shell script.
 *
 * ONE SOURCE, NO FALLBACK. contextualize-stories.sh preferred prompts/cpa-system.md and fell
 * back to a copy embedded in the script. That file has never existed — so every CPA run
 * warned "prompt not found, using built-in fallback (non-blocking)" and quietly ran the
 * embedded copy. Two sources, one dead, and the live one invisible to review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/cpa-inference.golden.json');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const CTX = join(ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const { renderEngineTemplate } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

describe('cpa-inference kept every byte', () => {
  it('the golden matches its digests and the branches differ', () => {
    const g = golden();
    expect(createHash('sha256').update(g.output.full).digest('hex')).toBe(g.sha256.full);
    expect(g.output.full).not.toBe(g.output.bare);
  });

  it('reproduces both the populated and the bare envelope exactly', () => {
    const g = golden();
    const { buildPrompt } = require(join(ROOT, 'orchestrations/scripts/lib/cpa-inference.js'));
    expect(buildPrompt(g.fixtures.FULL)).toBe(g.output.full);
    expect(buildPrompt(g.fixtures.BARE)).toBe(g.output.bare);
  });
});

describe('cpa-system is the single source', () => {
  it('the template exists and renders non-empty with no values', () => {
    expect(existsSync(T('cpa-system'))).toBe(true);
    const out = renderEngineTemplate('cpa-system', {});
    expect(out.length).toBeGreaterThan(200);
    expect(out).toMatch(/Contextual Purveyor Agent/);
  });

  it('the script no longer carries a second copy or a dead file branch', () => {
    const src = readFileSync(CTX, 'utf8');
    expect(src, 'the embedded prompt is still here').not.toMatch(/You are the Contextual Purveyor Agent/);
    expect(src, 'the dead SYSTEM_PROMPT_FILE branch survives').not.toContain('SYSTEM_PROMPT_FILE');
  });

  it('an empty render is fatal rather than a warning', () => {
    // An estimator with no instructions produces an estimate that looks like every other one.
    const src = readFileSync(CTX, 'utf8');
    expect(src).toMatch(/refusing to run the estimator with no instructions/);
    // The specific dead warning, not the word "non-blocking" — that also appears in the
    // unrelated auto-calibration step, which is legitimately non-blocking.
    expect(src).not.toMatch(/Using built-in fallback prompt/);
  });
});

describe('both seams declare their template', () => {
  it('cpa-inference and cpa-gate resolve', () => {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    expect(r.profiles['cpa-inference']?.template).toBe('cpa-inference');
    expect(r.profiles['cpa-gate']?.template).toBe('cpa-system');
  });

  it('neither template names a project or a fixture value', () => {
    for (const id of ['cpa-inference', 'cpa-system']) {
      const body = JSON.parse(readFileSync(T(id), 'utf8')).body as string;
      for (const lit of ['SYSPROMPT_S', 'KBCHUNK_S', 'metrolinx', 'gotransit']) {
        expect(body, `${id} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});
