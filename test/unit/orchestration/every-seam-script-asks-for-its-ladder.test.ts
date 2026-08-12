/**
 * A REACHABLE LADDER NOBODY ASKS FOR IS STILL NOT A LADDER ASSIGNMENT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Two fixes landed before this one: the ladders are now loaded where the orchestrator can see
 * them, and every agent — minted or named — resolves to a seam. Neither makes a seam ASK.
 * seam_ladder_export was called by exactly ONE script (team-lead-review.sh); every other seam
 * kept the fixed model its script had hardcoded:
 *
 *     code-review-cycle.sh              ORCH_GATE_MODEL
 *     brownfield-repro-test-writer.sh   ESCALATION_MODEL_HIGH
 *     agent-attempt-analyst.sh          ESCALATION_MODEL / ORCH_GATE_MODEL
 *
 * So the registry governed one of seventeen callers while looking authoritative — which is how
 * "all 17 seams have ladders, every agent can escalate" was reported on 2026-08-11 about a
 * change that altered nothing for sixteen of them.
 *
 * This asserts the ASK, for every seam script, and it is DATA-DRIVEN on purpose: a seam script
 * added tomorrow is covered without anyone remembering this file exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const REGISTRY = JSON.parse(
  readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));

/**
 * Every script that invokes an agent and therefore needs a model.
 *
 * Listed with the seam each enters by, because a script's filename is not its seam — the
 * mapping is a decision, not a convention. claude.sh and the launchers are excluded: they run
 * the STORY ladder, which is a different mechanism with its own tests.
 */
const SEAM_SCRIPTS: Array<{ file: string; seam: string }> = [
  { file: 'team-lead-review.sh', seam: 'team-lead-review' },
  { file: 'code-review-cycle.sh', seam: 'code-review-cycle' },
  { file: 'brownfield-repro-test-writer.sh', seam: 'repro-test-writer' },
  { file: 'post-impl-tc-writer.sh', seam: 'tc-writer' },
  { file: 'update-invalidated-tests.sh', seam: 'repro-test-writer' },
  { file: 'agent-attempt-analyst.sh', seam: 'agent-failure-analyst' },
  { file: 'contextualize-stories.sh', seam: 'cpa-inference' },
];

const src = (f: string) => readFileSync(join(SCRIPTS, f), 'utf8');

describe('the list is real — otherwise this passes vacuously', () => {
  it('every listed script exists', () => {
    for (const { file } of SEAM_SCRIPTS) {
      expect(existsSync(join(SCRIPTS, file)), `${file} is gone — update the list`).toBe(true);
    }
  });

  it('every seam named here is a profile the registry defines', () => {
    for (const { file, seam } of SEAM_SCRIPTS) {
      expect(REGISTRY.profiles[seam], `${file} claims seam '${seam}', which does not exist`).toBeTruthy();
    }
  });

  it('every seam used here declares a ladder', () => {
    for (const { file, seam } of SEAM_SCRIPTS) {
      expect(REGISTRY.profiles[seam].ladder, `${file}'s seam '${seam}' has no ladder`).toBeTruthy();
    }
  });
});

describe.each(SEAM_SCRIPTS)('$file', ({ file, seam }) => {
  it('sources the seam-ladder library', () => {
    expect(src(file), 'cannot ask for a ladder without the library').toMatch(/lib\/seam-ladder\.sh/);
  });

  it(`asks for its ladder as '${seam}'`, () => {
    const s = src(file);
    expect(s, 'the script never asks — it keeps whatever fixed model it had')
      .toMatch(new RegExp(`seam_ladder_export\\s+["']${seam.replace(/[-]/g, '[-]')}["']`));
  });

  it('asks BEFORE it resolves a model, or the export is overwritten', () => {
    // seam_ladder_export sets EPAM_MODEL. A later `MODEL="${ORCH_GATE_MODEL:-...}"` that wins
    // makes the whole thing decorative — the ordering IS the behaviour.
    const s = src(file);
    const ask = s.search(/seam_ladder_export\s+["']/);
    expect(ask, 'no ask at all').toBeGreaterThan(-1);
    const firstModelAssign = s.search(/^\s*(export\s+)?[A-Z_]*MODEL[A-Z_]*=/m);
    if (firstModelAssign > -1) {
      expect(ask, 'a model is fixed before the seam is asked, so the ladder cannot apply')
        .toBeLessThan(firstModelAssign);
    }
  });

  it('guards the call, so a missing library degrades instead of aborting the run', () => {
    // These scripts run mid-pipeline. `command -v` keeps a packaging error from killing a run
    // — the run continues on its previous fixed model, which is what it did before this change.
    expect(src(file)).toMatch(/command -v seam_ladder_export/);
  });
});

describe('NO SEAM SCRIPT IS LEFT OUT', () => {
  it('every script that invokes an agent is on the list', () => {
    // The check that stops this file going stale: if a script calls the agent runner and is
    // not listed here, it silently runs without a ladder — the exact gap this fixes.
    const { readdirSync } = require('node:fs');
    const invokers = readdirSync(SCRIPTS)
      .filter((f: string) => f.endsWith('.sh'))
      .filter((f: string) => {
        const s = src(f);
        return /ai-run\.sh|invoke_agent/.test(s);
      });
    // claude.sh and tier3-* launchers drive the STORY ladder, tested separately.
    const exempt = new Set(['claude.sh', 'ai-run.sh', 'orchestrate.sh', 'run-agent-orchestration.sh',
      'test-engine.sh', 'kill-tier3-run.sh', 'vc-coverage-check.sh']);
    const listed = new Set(SEAM_SCRIPTS.map((s) => s.file));
    const missing = invokers.filter((f: string) => !exempt.has(f) && !f.startsWith('tier3-') && !listed.has(f));
    expect(missing, 'these invoke an agent and ask for no ladder').toEqual([]);
  });
});
