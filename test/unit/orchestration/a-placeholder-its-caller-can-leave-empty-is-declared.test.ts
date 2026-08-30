/**
 * A PLACEHOLDER ITS CALLER CAN LEAVE EMPTY MUST BE DECLARED, OR THE SEAM DIES IN THAT STATE.
 *
 * prompt-library refuses any declared placeholder that renders empty — correctly, because an agent
 * cannot tell a failed lookup from a genuinely absent one. So when a renderer initialises a value
 * to "" and fills it only conditionally, the seam CANNOT RUN in the un-filled state, and says only
 * that it "did not render".
 *
 * Found three times before this scanner existed, each time by driving one seam:
 *
 *   code-review-cycle   __PRIOR_CONTEXT__   empty on iteration 1 — so no FIRST review ever ran
 *   repro-test-writer   __EXAMPLE_BLOCK__   empty with no test to mirror — the repo that most
 *                                           needs a repro test was the one case it refused
 *   agent-failure-analyst __PROFILE__       the caller says "when present"; the render disagreed
 *
 * This finds the shape rather than the instances: a variable explicitly initialised to "" and
 * passed to a template that does not declare the placeholder optional.
 *
 * IT IS A CANDIDATE LIST, NOT A VERDICT — which is why every exception carries a written reason
 * rather than a bare name. _REVIEW_PROFILE looked identical and is NOT this defect: its caller
 * exits 1 with "Refusing to review with an identity nobody chose" before ever rendering. Declaring
 * that one optional would have loosened a guard instead of narrowing one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');
const SCRIPTS = join(REPO, 'orchestrations/scripts');

/**
 * Placeholders whose renderer can leave them empty and which are NOT declared optional, each with
 * the reason it is allowed to stand. A bare name is not permitted: the point of the list is that
 * somebody decided, and said why.
 */
const REVIEWED: Record<string, string> = {
  'code-review-cycle:__REVIEW_PROFILE__':
    'not this defect — roster_persona failing exits 1 before the render, so empty never reaches it',
  'code-review-cycle:__STORY_DIFF__':
    'a story whose diff is empty changed nothing; refusing is the correct outcome, not a gap',
  'agent-retry-prefix:__TC_BN_ERR__': 'PENDING: not yet driven; reachability unverified',
  'corrective-note:__MC_CORRECTIVE_NOTE__': 'PENDING: not yet driven; reachability unverified',
  'failure-analyst:__VERIFICATION_FAILURE__': 'PENDING: not yet driven; reachability unverified',
  'lint-ac-remediator:__FINDING__': 'PENDING: not yet driven; reachability unverified',
  'tc-writer:__TC_WRITER_PROFILE__': 'PENDING: not yet driven; reachability unverified',
};

function shellScripts(): [string, string][] {
  const out: [string, string][] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (!/node_modules|archived/.test(p)) walk(p); continue; }
      if (p.endsWith('.sh')) out.push([p, readFileSync(p, 'utf8')]);
    }
  })(SCRIPTS);
  return out;
}

/** Every (template, placeholder) whose renderer initialises its value to "" and fills it later. */
function canBeLeftEmpty(): { key: string; script: string; variable: string }[] {
  const scripts = shellScripts();
  const found: { key: string; script: string; variable: string }[] = [];
  for (const f of readdirSync(TEMPLATES).filter((x) => x.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '');
    let t: any;
    try { t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8')); } catch { continue; }
    const may = new Set<string>(t.mayBeEmpty || []);
    for (const [sp, src] of scripts) {
      if (!new RegExp(`(render_engine_prompt|render)\\s+${id}\\b`).test(src)) continue;
      for (const p of (t.placeholders || []) as string[]) {
        if (may.has(p)) continue;
        const arg = p.replace(/^__|__$/g, '').toLowerCase();
        const m = new RegExp(`--arg\\s+${arg}\\s+"\\$\\{?([A-Za-z_][A-Za-z0-9_]*)`).exec(src);
        if (!m) continue;
        if (!new RegExp(`^\\s*${m[1]}=""\\s*$`, 'm').test(src)) continue;
        found.push({ key: `${id}:${p}`, script: sp.replace(`${REPO}/`, ''), variable: m[1] });
      }
    }
  }
  return found;
}

describe('a placeholder its caller can leave empty is declared', () => {
  it('the scanner sees templates and renderers at all', () => {
    // Without this, an empty result would be indistinguishable from a clean one.
    expect(readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).length,
      'no templates found — the scan proves nothing').toBeGreaterThan(10);
    expect(shellScripts().length, 'no renderer scripts found').toBeGreaterThan(10);
  });

  it('and it still finds the shape it was written for', () => {
    // Guards against the scanner silently matching nothing after a refactor: the reviewed list
    // below is only meaningful while the detector still detects.
    expect(canBeLeftEmpty().length, 'the scanner now finds NOTHING, which is not credible — its '
      + 'regexes no longer match the code they were written against').toBeGreaterThan(0);
  });

  it('every one is either declared optional or has a written reason', () => {
    const undecided = canBeLeftEmpty()
      .filter((r) => !REVIEWED[r.key])
      .map((r) => `${r.key}  ($${r.variable} in ${r.script})`);
    expect(undecided, 'these can render empty, are not declared mayBeEmpty, and nobody has said '
      + 'why that is acceptable — in that state the seam refuses to render and reports only that '
      + 'it "did not render"').toEqual([]);
  });

  it('and no reason is left blank', () => {
    const blank = Object.entries(REVIEWED).filter(([, why]) => !why || why.trim().length < 20);
    expect(blank.map(([k]) => k), 'these are listed with no real reason').toEqual([]);
  });
});
