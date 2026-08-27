/**
 * A CACHED PROMPT THAT WAS NEVER REVIEWED MUST NOT COUNT AS REVIEWED.
 *
 * The prompt cache memoises on (template, generatorBody, contexts). It records nothing about
 * whether the prompt passed REVIEW, so once review was finally switched on, 39 entries written while
 * it was off were reused verbatim — never regenerated, therefore never reviewed — and the run
 * reported "prompt review ENABLED" while reviewing almost nothing.
 *
 * Memoisation keyed on inputs must also be keyed on the gates the artefact passed. Otherwise turning
 * a gate on has no effect until something unrelated invalidates the cache, and the log says the gate
 * is running.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProjectPrompts } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));

/** A project with one template, so the assertion is about caching and nothing else. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'reused-review-'));
  const templates = join(dir, 'templates');
  const proj = join(dir, 'project');
  mkdirSync(templates, { recursive: true });
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  writeFileSync(join(templates, 'probe.json'), JSON.stringify({
    id: 'probe', version: 1, description: 'a probe', layer: 'project', placeholders: ['__X__'],
    body: 'Do the work for __X__.',
  }));
  // The generator prompt is copied verbatim — it cannot be its own output.
  writeFileSync(join(templates, 'project-prompt-generation.json'), JSON.stringify({
    id: 'project-prompt-generation', version: 1, description: 'the generator', layer: 'project',
    placeholders: ['__GEN_TEMPLATE_ID__', '__GEN_TEMPLATE_BODY__'],
    body: 'Specialise __GEN_TEMPLATE_ID__:\n-----BEGIN TEMPLATE BODY-----\n__GEN_TEMPLATE_BODY__\n-----END TEMPLATE BODY-----',
  }));
  writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({
    copyVerbatim: ['project-prompt-generation'], generated: ['probe'],
  }));
    // A seam must DECLARE the template, or the builder classifies it engine-layer and never
  // provisions it — nothing would read a project copy.
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ profiles: { probe: { template: 'probe' } } }));
  return { dir, templates, proj };
}

const run = (p: any, opts: any = {}) => buildProjectPrompts({
  templatesDir: p.templates,
  bootstrapFile: join(p.dir, 'bootstrap.json'),
  registryFile: join(p.dir, 'registry.json'),
  projectConfigDir: p.proj,
  projectContext: 'ctx', codelineContext: 'cl', mintedRoles: '',
  runText: async () => 'Do the work for __X__.',
  log: (m: string) => { (globalThis as any).__log = ((globalThis as any).__log||[]).concat(m); },
  ...opts,
});

describe('a reused prompt must have been reviewed', () => {
  it('the cache is actually being used — otherwise this proves nothing', async () => {
    const p = project();
    try {
      await run(p);
      const cache = join(p.proj, '.prompt-cache');
      // eslint-disable-next-line no-console
      console.log('BUILDER LOG:', ((globalThis as any).__log||[]).join(' | ').slice(0,400));
      expect(existsSync(cache) && readdirSync(cache).length, 'nothing was cached').toBeTruthy();
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('REPRODUCES the defect: a prompt cached WITHOUT review is not reused once review is on', async () => {
    const p = project();
    try {
      // First run: no reviewer at all — this is how all 39 entries were written.
      await run(p);
      // Second run: review is ON. The cached entry was never reviewed, so it must NOT be reused.
      let reviewed = 0;
      await run(p, { reviewPrompt: async () => { reviewed += 1; return { ok: true }; } });
      expect(reviewed,
        'the prompt was served from a cache entry written before review existed — turning review on '
        + 'changed nothing, and the run still reports review as enabled')
        .toBeGreaterThan(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });

  it('a prompt cached WITH review is reused — the fix must not disable caching', async () => {
    const p = project();
    try {
      const rev = async () => ({ ok: true });
      await run(p, { reviewPrompt: rev });
      let reviewedAgain = 0;
      await run(p, { reviewPrompt: async () => { reviewedAgain += 1; return { ok: true }; } });
      expect(reviewedAgain,
        'a reviewed prompt was reviewed again — the cache is now useless and every run pays twice')
        .toBe(0);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  });
});
