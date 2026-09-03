/**
 * RESUMING AFTER PAUSE 2 MUST RUN THE WRITER, NOT THE SPEC PASS AGAIN.
 *
 * This is the point of pause 2: the spec, the CPA sizing and the detective are all settled and
 * inspectable, no code exists yet, and the operator approves the inputs before any writing
 * happens. Resuming is supposed to pick the writer up from there.
 *
 * It never could on a multi-codeline run. Since 2026-08-03 checkpoint_dir() resolves per lane,
 * so `save_run_checkpoint "$PHASE" pre-writer` — which runs INSIDE a lane — writes to
 * runs/<id>/lanes/<codeline>/checkpoint. `post-roster` is saved by the PARENT, to
 * runs/<id>/checkpoint. resume_skip_env() runs in the parent and reads the parent directory:
 * it finds post-roster, emits only EPAM_SKIP_AGENT_MINT=1, and Step 1 runs again.
 *
 * Live 2026-08-09 that cost ~50 minutes per resume (16-19 min of spec pass x 3 lanes) and,
 * worse, REGENERATED the specs the operator had just approved at the pause — the writer would
 * have built against artefacts nobody reviewed.
 *
 * The run's stage is derived from its lanes, the way the story's completion is derived from
 * per-codeline outcomes: a run is at pre-writer only when EVERY lane has reached pre-writer.
 * The least-advanced lane decides, so a run whose third lane never got there cannot skip a spec
 * pass that lane never ran.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const RUN = '20260809T045158Z';

/** A run directory with a parent stage and any number of lane stages. */
function runDir(parentStage: string | null, laneStages: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ckpt-')); dirs.push(base);
  const write = (dir: string, stage: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'),
      JSON.stringify({ runId: RUN, phase: 'core', stage, createdAt: '2026-08-09T05:01:00Z', storyCount: 1 }));
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [] }));
  };
  if (parentStage) write(join(base, 'runs', RUN, 'checkpoint'), parentStage);
  for (const [lane, stage] of Object.entries(laneStages)) {
    write(join(base, 'runs', RUN, 'lanes', lane, 'checkpoint'), stage);
  }
  return base;
}

/** resume_skip_env as the PARENT calls it. */
function skipEnv(base: string): string[] {
  const out = execFileSync('bash', ['-c',
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(base)};
     is_parent() { return 0; }
     . ${JSON.stringify(LIB)} >/dev/null 2>&1
     resume_skip_env ${JSON.stringify(RUN)} 2>/dev/null || echo "__FAILED__"`,
  ], { encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean);
}

describe('the harness reflects the live layout', () => {
  it('the parent sits at post-roster while the lanes sit at pre-writer — the live shape', () => {
    const base = runDir('post-roster', { gotransit: 'pre-writer', upexpress: 'pre-writer', metrolinx: 'pre-writer' });
    expect(skipEnv(base)).not.toContain('__FAILED__');
  });
});

describe('THE DEFECT: every lane at pre-writer means the run is at pre-writer', () => {
  const base = () => runDir('post-roster', { gotransit: 'pre-writer', upexpress: 'pre-writer', metrolinx: 'pre-writer' });

  it('the spec pass is skipped', () => {
    expect(
      skipEnv(base()),
      'the spec pass re-runs, regenerating the artefacts approved at the pause',
    ).toContain('EPAM_SPEC_MODE=0');
  });

  it('the CPA pre-pass and skill assessment are skipped too', () => {
    const env = skipEnv(base());
    expect(env).toContain('SKIP_CPA=1');
    expect(env).toContain('SKIP_SKILL_ASSESSMENT=1');
  });

  it('the mint is still skipped — the roster reviewed at the pause is reused', () => {
    expect(skipEnv(base())).toContain('EPAM_SKIP_AGENT_MINT=1');
  });
});

describe('the least-advanced lane decides — nothing is skipped that a lane never did', () => {
  it('one lane short of pre-writer keeps the spec pass ON', () => {
    const base = runDir('post-roster', { gotransit: 'pre-writer', upexpress: 'pre-writer', metrolinx: 'post-roster' });
    expect(
      skipEnv(base),
      'a lane that never ran its spec pass would be skipped past it',
    ).not.toContain('EPAM_SPEC_MODE=0');
  });

  it('a lane at post-spec holds the run at post-spec', () => {
    const base = runDir('post-roster', { gotransit: 'pre-writer', upexpress: 'post-spec' });
    const env = skipEnv(base);
    expect(env).toContain('EPAM_SPEC_MODE=0');
    expect(env).not.toContain('SKIP_CPA=1');
  });
});

describe('single-lane and parent-only runs are unchanged', () => {
  it('a flat run with no lanes uses its own stage', () => {
    const base = runDir('pre-writer');
    expect(skipEnv(base)).toContain('EPAM_SPEC_MODE=0');
  });

  it('a parent-only post-roster run skips the mint and the ingest, and nothing else', () => {
    // The ingest skip joined every stage on 2026-08-09: re-ingesting overwrites PRD_FILE with
    // the spec-free Jira synthesis, and a PRD already exists at post-roster because ingest runs
    // before the mint. See resume-does-not-re-ingest-over-the-spec. The set is still asserted
    // exactly — nothing further may be skipped at post-roster.
    const env = skipEnv(runDir('post-roster'));
    // The set of SKIPS is still asserted exactly — that is the requirement this test states.
    // resume_skip_env also publishes the stage the resume started from, which is a fact about
    // the resume rather than something skipped: the pauses compare against it instead of
    // re-deriving it from a tree the run is actively writing to, which is how pause 2 came to
    // skip itself (2026-08-28).
    const skips = env.filter((a: string) => /^(EPAM_)?SKIP_/.test(a)).sort();
    expect(skips).toEqual(['EPAM_SKIP_AGENT_MINT=1', 'EPAM_SKIP_JIRA_INGEST=1']);
    expect(env).toContain('EPAM_RESUMED_FROM_STAGE=post-roster');
  });

  it('no checkpoint at all still refuses rather than guessing', () => {
    expect(skipEnv(runDir(null))).toContain('__FAILED__');
  });
});

describe('a lane checkpoint never makes the run LESS advanced than the parent', () => {
  it('a parent already at pre-writer is not dragged back by a stale lane', () => {
    // Defensive: the parent's own stage is a floor, never overridden downwards.
    const base = runDir('pre-writer', { gotransit: 'post-roster' });
    expect(skipEnv(base)).toContain('EPAM_SPEC_MODE=0');
  });
});
