/**
 * THE SUITE IMPORTS src/. PRODUCTION RUNS dist/. THIS CLASS OF DEFECT ONLY EXISTS IN dist/.
 *
 * Three files resolved orchestrations/prompts/templates by counting directories up from
 * __dirname, each with a DIFFERENT count — '../..', '../../..', '../..'. Every count is correct
 * from that file's own location in the source tree, and every one is wrong from the compiled
 * bundle, because tsup flattens all of it into dist/*.js one level below the repository root. At
 * runtime they resolved ABOVE the repository and threw ENOENT.
 *
 * The existing tests could not see it. test/unit/agent/roles.test.ts EXECUTES squadPrompt — the
 * exact function that killed a launch — and passes 8/8, because it imports '../../../src/...' and
 * vitest resolves that to the source tree where the guess happens to be right. `tsc --noEmit`
 * cannot see it either: the paths are string literals, valid TypeScript, wrong at runtime.
 *
 * Of 978 test files, 31 touch dist/ at all. So ~97% of the suite is structurally incapable of
 * catching anything that lives in the build output. It cost three consecutive mock3 launches —
 * the mint first ("cannot load the agent proposal prompt from dist/sdk.js"), then codeline
 * discovery on squad-leader.json — each found only by actually running the pipeline.
 *
 * This test requires the COMPILED artefacts and exercises every template consumer through them.
 * It is the only shape that can fail before a launch does.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { templatesDir } from '../../../src/prompts/templatesDir';

const ROOT = join(__dirname, '../../..');
const SDK = join(ROOT, 'dist/sdk.js');
const EPAM = join(ROOT, 'dist/epam.js');

/** Run an expression against a compiled bundle, in a fresh process, as the pipeline does. */
function inBundle(bundle: string, expr: string): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ['-e', expr.replace('__B__', JSON.stringify(bundle))], {
    encoding: 'utf8', cwd: ROOT,
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

describe('the compiled bundle finds its templates', () => {
  it('the bundles exist — a stale or absent dist is itself the defect', () => {
    // dist/sdk.js was also SIX DAYS STALE when this was found: it predated the change that moved
    // these prompts into the template layer, so the mint was still loading the old build.
    for (const b of [SDK, EPAM]) {
      expect(existsSync(b), `${b} is missing — run tsup. The pipeline loads prompts from it.`).toBe(true);
    }
  });

  it('the mint can load its agent-proposal prompt from dist/sdk.js', () => {
    // spec-mode-runner.js raises "[mint] cannot load the agent proposal prompt from dist/sdk.js"
    // on exactly this. It is the FIRST agent of every run.
    const r = inBundle(SDK, 'process.stdout.write(String(require(__B__).getAgentProposalPrompt()))');
    expect(r.ok, `the mint would fail here: ${r.out.slice(0, 300)}`).toBe(true);
    expect(r.out.length, 'the mint prompt rendered empty').toBeGreaterThan(200);
  });

  it('dist/epam.js loads without resolving a template above the repository', () => {
    // squadPrompt runs at MODULE LOAD, so a bad path takes the whole bundle down — which is how
    // codeline discovery died: ENOENT on /home/bradleyjerome/projects/orchestrations/...
    const r = inBundle(EPAM, 'require(__B__); process.stdout.write("loaded")');
    expect(r.ok, `dist/epam.js fails to load: ${r.out.slice(0, 400)}`).toBe(true);
  });

  it('no compiled bundle ever reaches outside the repository for a template', () => {
    // The signature of this class: a path that climbed past the repo root.
    const parent = join(ROOT, '..');
    for (const b of [SDK, EPAM]) {
      const r = inBundle(b, 'try{require(__B__)}catch(e){process.stdout.write(String(e.message))}');
      expect(r.out, `${b} resolved a template outside the repository:\n${r.out.slice(0, 300)}`)
        .not.toContain(join(parent, 'orchestrations'));
    }
  });

  it('no source file counts directory levels to find the template layer', () => {
    // The root cause, held shut. Three files each hardcoded a different depth; all were right
    // from src/ and wrong from dist/. templatesDir() walks up instead, so there is no count to
    // get wrong — and no fourth instance can be added by copying the pattern.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const body = readFileSync(p, 'utf8').split('\n')
          .filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
        if (/__dirname,\s*'\.\.[^']*',\s*'orchestrations'/.test(body)
            || /join\(__dirname,\s*'[^']*'\s*,\s*'orchestrations'/.test(body)) {
          offenders.push(p.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders,
      `${offenders.length} file(s) count levels to the template layer instead of asking `
      + 'templatesDir(). Correct from src/, wrong from dist/, invisible to every test that '
      + 'imports src/:',
    ).toEqual([]);
  });

  it('the shared resolver finds the same directory from anywhere', () => {
    // DEPTH-INDEPENDENCE IS THE PROPERTY. If it only worked from one location it would be the old
    // bug with more steps.
    //
    // This calls the REAL resolver rather than reimplementing its walk: a copy here would be a
    // second implementation to keep in step, and it would keep passing after the real one broke —
    // which is the whole failure mode this file exists to catch. The path segments are its
    // knowledge, not this test's, so they are not written down again either.
    const fromResolver = templatesDir();

    // Whatever it returns must be the directory the pipeline's own templates live in — proven by
    // a template every consumer needs, not by a path spelled out here.
    expect(fromResolver, 'the resolver did not answer').toBeTruthy();
    expect(existsSync(join(fromResolver, 'squad-leader.json')),
      `the resolver returned ${fromResolver}, which does not hold the templates`).toBe(true);
  });
});
