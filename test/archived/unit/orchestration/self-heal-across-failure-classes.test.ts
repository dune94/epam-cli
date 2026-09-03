/**
 * ONE HAPPY PATH IS NOT A TEST OF A MECHANISM WITH FIVE OUTCOMES.
 *
 * My first self-heal test executed exactly ONE case — failure class `provider` — which is the class
 * agent-attempt-analyst.sh is DOCUMENTED to skip without doing anything. It passed, and I reported
 * self-heal as wired. It was not: the analyst resolves its model from AGENT_ANALYST_MODEL, the rung,
 * ESCALATION_MODEL or EPAM_MODEL, and with none set it exits 0 SILENTLY —
 * "Not analysing rather than guessing a model." A seam's model lives in its per-call env and never
 * in process.env, so nothing reached the analyst and it DECLINED on every invocation.
 *
 * Live 2026-08-27, run 20260827T151832Z: seven refusals, ZERO healing episodes, ZERO rc=2. The
 * analyst was not failing, it was declining, and the two were indistinguishable from outside — which
 * is precisely why the single happy-path test could not see it.
 *
 * So this exercises every outcome the mechanism has, and the actionable path is driven through a
 * STUBBED runner (AI_RUNNER_CMD) rather than a real model — the technique this repo already uses in
 * ~180 test files. No tokens are spent and the path that actually matters is the one under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selfHeal } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/self-heal.js'));

let dir: string;
let stub: string;

let prevCfg: string | undefined;
beforeAll(() => {
  process.env.EPAM_PROVIDER_SET = process.env.EPAM_PROVIDER_SET || 'claude';
  dir = mkdtempSync(join(tmpdir(), 'self-heal-cases-'));
  // The analyst resolves its rung from the project's llm-settings.json, so the isolated project
  // carries the real one — the settings are the subject, the KB is not.
  PROJECT_DIR = join(dir, 'project');
  mkdirSync(join(PROJECT_DIR, 'kb'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'orchestrations/projects/mock3/llm-settings.json'),
    join(PROJECT_DIR, 'llm-settings.json'));
  // A runner that answers instantly with a corrective — so the ACTIONABLE path is exercised
  // without a model call. Without this, the only affordable case is the one that does nothing.
  stub = join(dir, 'stub-runner.sh');
  writeFileSync(stub, '#!/usr/bin/env bash\ncat >/dev/null 2>&1\n'
    + 'echo "COVER THE MISSING PLACEHOLDERS EXACTLY AS THE TEMPLATE STATES THEM."\n');
  chmodSync(stub, 0o755);
});
afterAll(() => {
  if (prevCfg === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR;
  else process.env.EPAM_PROJECT_CONFIG_DIR = prevCfg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

// The environment a RUN has. EPAM_PROJECT_CONFIG_DIR is how the analyst finds llm-settings.json and
// resolves the rung to heal on; without it, it declines with
// "[model-ladders] settings file not found" — which is a second way to be inert, and one this suite
// found only because the actionable case is now genuinely exercised.
// A PROJECT THIS TEST OWNS. Pointing at the real mock3 KB made the assertion depend on a file
// every other probe and run also appends to — the count moved for reasons that had nothing to do
// with the call under test. Its own directory makes the artifact assertion exact.
let PROJECT_DIR = '';

/**
 * The KB the analyst records into. NOT orchestrations/agents/kb — that is the engine's, and reading
 * it is how "0 episodes" was measured against the wrong file for an hour. The store roots at the
 * PROJECT.
 */
function countEpisodes(): number {
  try {
    return readFileSync(join(PROJECT_DIR, 'kb', 'healing-events.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

const call = (over: any = {}) => selfHeal({
  agent: 'case-probe', storyId: 'S1', projectConfigDir: PROJECT_DIR,
  reason: 'the generated prompt dropped placeholder(s) the template requires: __X__',
  output: 'the body the agent actually returned',
  ...over,
});

describe('self-heal, across every outcome it has', () => {
  it('CASE nothing can resolve a model — declines VISIBLY rather than looking like success', () => {
    // THE DEFECT THIS SUITE EXISTS FOR. The analyst refuses to guess a model — correct — and exits
    // 0 doing nothing. Indistinguishable from a healthy run unless the decline is reported, which is
    // how a wired mechanism stayed inert for a whole run behind a green test.
    // Stated, not mutated: with no project and no model there is nothing to resolve a rung from.
    const r = selfHeal({ agent: 'case-probe', storyId: 'S1', reason: 'dropped placeholder(s)',
      output: 'body', model: '', provider: '', projectConfigDir: '' });
    {
      expect(r.ran, 'the analyst was never invoked at all').toBe(true);
      expect(r.analysed, 'it cannot have analysed with no model anywhere').toBe(false);
      expect(r.declined, 'a decline must be visible — it is not the same as having healed').toBe(true);
      expect(r.declinedReason, 'a decline must say WHY, or it is just silence again').toBeTruthy();
    }
  });

  it('CASE a rung is available — the analyst uses it rather than declining', () => {
    // The other side of the same coin: with a project in scope the ladder supplies the rung, and
    // declining THEN would be the mechanism failing quietly in the opposite direction.
    const r = call({ model: '', provider: '', runner: stub });
    expect(r.analysed || r.rc === 2,
      `neither analysed nor failed — it declined with a rung available: ${r.declinedReason}`).toBe(true);
  });

  it('CASE actionable class WITH a model — actually analyses and returns a corrective', () => {
    // The path that matters, and the one the original test never touched.
    const episodesBefore = countEpisodes();
    const r = call({ model: 'stub-model', provider: 'claude', runner: stub });
    const episodesAfter = countEpisodes();
    expect(r.ran).toBe(true);
    expect(r.rc, 'the analyst itself failed').not.toBe(2);
    // THE ASSERTION THAT MAKES THIS A TEST. The stub answers with a known corrective; if it does
    // not come back, the analyst never reached its runner and the mechanism is inert for every real
    // failure no matter how the wiring reads.
    // THE ASSERTION THAT MAKES THIS A TEST: an EPISODE LANDS IN THE KB.
    //
    // Not a stderr string, not an exit code — the artifact. Run 20260827T151832Z recorded ZERO
    // episodes across seven refusals while every structural check said self-heal was wired, and a
    // string assertion would have passed there too: the analyst can resolve a rung from the ladder
    // even when the caller states none, so "it analysed" is true in the test and false in the run.
    // Only the episode count can tell those apart.
    expect(episodesAfter, `no episode was recorded — self-heal did nothing. ${r.declinedReason || r.stderr.slice(0, 200)}`)
      .toBeGreaterThan(episodesBefore);
    expect(r.declined, 'an analysis that ran must not report as a decline').toBe(false);
  });

  for (const [cls, reason] of [
    ['no-json', 'the response had no JSON at all'],
    ['max-iterations', 'agent reached maximum iterations'],
    ['no-output', ''],
    ['malformed', 'dropped output field(s) the template states'],
  ] as Array<[string, string]>) {
    it(`CASE ${cls} — never throws and always reports a distinguishable outcome`, () => {
      const r = call({ reason, output: cls === 'no-output' ? '' : 'something', model: 'stub-model', runner: stub });
      expect(r.ran).toBe(true);
      // Every outcome must be tellable apart: healed, deliberately skipped, or broken.
      expect(typeof r.declined).toBe('boolean');
      expect([0, 2]).toContain(r.rc);
    });
  }

  it('CASE analyst missing or unusable — reports, never throws', () => {
    expect(() => selfHeal({} as any)).not.toThrow();
    expect(() => selfHeal({ output: null, reason: null } as any)).not.toThrow();
  });

  it('every call site states the rung that produced the failure', () => {
    // The parameter whose absence made all of the above inert. Asserted per site, because one site
    // silently omitting it reproduces the original defect for that seam alone.
    const fs = require('fs');
    for (const f of [
      'orchestrations/scripts/lib/content-retry.js',
      'orchestrations/scripts/lib/project-prompt-builder.js',
      'orchestrations/scripts/lib/project-roster.js',
      'orchestrations/scripts/spec-mode-runner.js',
    ]) {
      const src = fs.readFileSync(join(REPO_ROOT, f), 'utf8');
      const calls = src.match(/selfHeal\(\{[\s\S]{0,600}?\}\)/g) || [];
      expect(calls.length, `${f} no longer calls selfHeal`).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c, `${f} calls self-heal without stating the model — the analyst will decline`)
          .toMatch(/model:/);
      }
    }
  });
});
