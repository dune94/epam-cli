/**
 * TEACH THE PRODUCER THE SHAPE — WITHOUT TEACHING IT A VOCABULARY.
 *
 * The VC producer was told the rules and then corrected afterwards by a guard. Across the
 * runs of 2026-08-06/07 the same three shapes kept being produced and then deleted:
 *
 *   - an assertion about INTERNAL STRUCTURE: "the options object passed to <sdk>.Stack()
 *     includes a live_preview key"
 *   - an assertion about an INTERNAL CALL PATH: "when getEntry / getSingleEntry is called
 *     with preview parameters, the resulting query includes ..."
 *   - a criterion starting OUTSIDE THE TESTABLE BOUNDARY: "when a content author edits and
 *     saves a draft entry in the CMS, the preview page updates ..."
 *
 * Rules alone did not prevent them. Contrast pairs do — provided they carry no vocabulary.
 *
 * WHY THAT PROVISO IS NOT PEDANTRY. The guard-vocabulary agent's persona contained exactly
 * one worked example — `"onEntryChange" is a useful blacklist term` — and the guard deleted
 * criteria quoting that vendor callback on three consecutive runs. An example is the most
 * powerful line in a prompt, which makes it the worst place to put a real name. Every noun in
 * these samples is a placeholder the model fills from its own story.
 *
 * The samples go to the PRODUCER only. The guard derives what it enforces from
 * VC_OBSERVABILITY_RULES plus this story's evidence; authored examples must never reach an
 * enforcement path, or vocabulary is back in the guard by the side door.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { readdirSync, existsSync } = require('node:fs');

/**
 * PER PROJECT, NOT IN THE ENGINE. Authored examples in engine code are content in the
 * generic pipeline: wrong for the next project and maintained by nobody. Each project
 * supplies its own file; a project with none simply gets no examples section.
 */
function projectSampleFiles(): string[] {
  const dir = join(ROOT, 'orchestrations/projects');
  return readdirSync(dir)
    .map((p: string) => join(dir, p, 'vc-form-samples.md'))
    .filter((f: string) => existsSync(f));
}
const SAMPLES = () => spec.vcFormSamples({ VC_FORM_SAMPLES_FILE: projectSampleFiles()[0] });

describe('the producer is shown what good and bad look like', () => {
  it('samples exist and are contrast pairs, not a single style', () => {
    expect(SAMPLES(), 'no samples are defined').toBeTruthy();
    const s = SAMPLES();
    expect(s).toMatch(/REJECTED/);
    expect(s).toMatch(/ACCEPTED/);
    expect((s.match(/REJECTED/g) || []).length, 'one example teaches one shape').toBeGreaterThan(2);
  });

  it('they cover the three shapes that were actually produced and deleted', () => {
    const s = SAMPLES().toLowerCase();
    expect(s, 'internal structure assertions').toMatch(/internal (structure|object|config)/);
    expect(s, 'internal call paths').toMatch(/call|invoked|path/);
    expect(s, 'criteria that begin outside the testable boundary').toMatch(/boundary|outside|drive/);
  });
});

describe('the samples name nothing real', () => {
  /** Every noun in an example must be a placeholder. */
  it('every example sentence uses <placeholders>', () => {
    const lines = SAMPLES().split('\n').filter((l: string) => /REJECTED|ACCEPTED/.test(l));
    expect(lines.length).toBeGreaterThan(4);
    for (const l of lines) {
      expect(l, `an example with no placeholder is naming something real: ${l}`).toMatch(/<[^>]+>/);
    }
  });

  it('no vendor, product, client or stack name appears', () => {
    // The classes that have actually leaked into prompts in this repo.
    const banned = /contentstack|onEntryChange|live_preview|preview_token|metrolinx|gotransit|upexpress|mozio|skyscanner|react|next\.js|express|node\b|jira|halving|promo|discount|dispatch/i;
    const hit = SAMPLES().match(banned);
    expect(hit && hit[0], 'a real name in a worked example is how a guard learned to delete a vendor callback').toBeFalsy();
  });

  it('no ticket ID or file path appears', () => {
    expect(SAMPLES()).not.toMatch(/\b[A-Z]{2,6}-\d+\b/);
    expect(SAMPLES()).not.toMatch(/src\/|\.tsx?\b/);
  });
});

describe('samples reach the producer and never the guard', () => {
  it('the engine itself ships NO sample text', () => {
    expect(projectSampleFiles().length, 'no project supplies samples — the rest is vacuous').toBeGreaterThan(0);
    expect(SRC, 'authored examples live in engine code, which is content in the generic pipeline')
      .not.toMatch(/REJECTED: "/);
  });

  it('a project without a samples file gets no examples section', () => {
    expect(spec.vcFormSamples({})).toBe('');
    expect(spec.vcFormSamples({ EPAM_PROJECT_CONFIG_DIR: '/does/not/exist' })).toBe('');
  });

  it('the location is configurable', () => {
    expect(spec.vcFormSamples({ VC_FORM_SAMPLES_FILE: projectSampleFiles()[0] })).toMatch(/REJECTED/);
  });

  it('the guard derives its vocabulary from the RULES, not from the samples', () => {
    const i = SRC.indexOf('async function deriveGuardVocabulary');
    const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
    expect(
      fn,
      'authored examples in an enforcement path put vocabulary back into the guard by the side door',
    ).not.toMatch(/vcFormSamples/);
  });

  it('the regeneration prompt shows them', () => {
    const i = SRC.indexOf('function regenerateVc');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(i, SRC.indexOf('\n}\n', i))).toMatch(/vcFormSamples/);
  });

  it('the first-pass producer shows them too — not only the retry', () => {
    const i = SRC.indexOf('function buildBrownfieldArchaeologyBlock');
    expect(SRC.slice(i, SRC.indexOf('\n}\n', i)), 'the producer only learns the shape after failing once')
      .toMatch(/vcFormSamples/);
  });
});

describe('the reviewer’s own output example carries no vocabulary either', () => {
  it('it does not quote a past ticket’s domain word', () => {
    // Only PROMPT text — a comment quoting the old example is documentation, not something
    // sent to a model, and anchoring on it tests the wrong string.
    const promptLines = SRC.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).join('\n');
    const i = promptLines.indexOf('Output ONLY a JSON array of short flag strings');
    expect(i, 'the reviewer output example moved').toBeGreaterThan(-1);
    const example = promptLines.slice(i, i + 240);
    expect(
      example,
      'the example flag quoted "halving" — the vocabulary of an unrelated fare-discount bug, ' +
        'shown to the reviewer on every ticket',
    ).not.toMatch(/halving|promo|discount|dispatch/i);
    expect(example, 'the example should still show the required FORM').toMatch(/VC \d|<[^>]+>/);
  });
});
