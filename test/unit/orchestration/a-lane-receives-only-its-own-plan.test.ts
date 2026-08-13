/**
 * A LANE RECEIVES ITS OWN PLAN AND NOBODY ELSE'S.
 *
 * WRITTEN BEFORE THE FIX. THE DEFECT IS MINE, INTRODUCED 2026-08-13.
 *
 * Three codelines run as parallel lanes, and each already gets a PRD scoped to itself —
 * run-agent-orchestration.sh:3216 replaces the flat fixSiteAnalysis with
 * fixSiteAnalysisPerCodeline[thisLane], for reasons recorded in its own comment: four killed runs
 * once turned gotransit's 13 fix sites into 22.
 *
 * Moving the plan onto the published-inputs framework broke that, in two ways at once:
 *
 *   PUBLISHED FROM THE WRONG PRD. Publication runs in the PARENT after the spec pass, from the
 *   canonical PRD, whose fixSiteAnalysis is the UNION of every lane — 13 sites where gotransit
 *   has 4.
 *
 *   READ FROM THE WRONG STORE. AGENT_IO_DIR is exported by the parent, so every lane inherits it
 *   and reads the parent's store instead of its own — defeating the per-lane LOG_DIR that exists
 *   precisely because shared lane state has corrupted runs before.
 *
 * Measured on the live AMSD-2041 PRD: gotransit's writer would receive 11,665 characters covering
 * 13 sites instead of 4,001 covering 4 — including three different prescriptions for
 * src/services/contentstack.ts naming five different env vars, two of them mutually exclusive
 * designs (management_token versus preview_token). A writer handed three conflicting instructions
 * for one file picks one, and nothing makes it pick this lane's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publishFixPlans } = require(join(ROOT, 'orchestrations/scripts/lib/producers/fix-plan.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const io = require(join(ROOT, 'orchestrations/scripts/lib/agent-io.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const store = () => {
  const d = mkdtempSync(join(tmpdir(), 'lane-plan-')); dirs.push(d);
  return { AGENT_IO_DIR: join(d, 'io') };
};

/** A story as a LANE's PRD carries it: scoped list, plus the per-codeline map it was scoped from. */
const laneStory = (codeline: string) => ({
  id: 'AMSD-1',
  codeline,
  fixSiteAnalysis: [{ file: `src/${codeline}.ts`, reason: `${codeline.toUpperCase()}-SITE`, fix: 'x' }],
  fixSiteAnalysisPerCodeline: {
    gotransit: [{ file: 'src/gotransit.ts', reason: 'GOTRANSIT-SITE', fix: 'x' }],
    upexpress: [{ file: 'src/upexpress.ts', reason: 'UPEXPRESS-SITE', fix: 'x' }],
    metrolinx: [{ file: 'src/metrolinx.ts', reason: 'METROLINX-SITE', fix: 'x' }],
  },
});

describe('THE PLAN PUBLISHED FOR A LANE IS THAT LANE\'S PLAN', () => {
  it('a story that names its codeline publishes only that codeline sites', () => {
    const env = store();
    publishFixPlans({ stories: [laneStory('gotransit')] }, env);
    const out = io.collect('AMSD-1', ['fix-plan'], env);
    expect(out).toContain('GOTRANSIT-SITE');
    expect(out, 'another lane plan reached this lane writer').not.toContain('UPEXPRESS-SITE');
    expect(out, 'another lane plan reached this lane writer').not.toContain('METROLINX-SITE');
  });

  it('the per-codeline map WINS over a flat list that disagrees with it', () => {
    // The canonical PRD's flat list is the union of every lane. If publication ever runs against
    // it while a codeline is known, the lane must still get its own — this is the belt to the
    // per-lane PRD's braces, because the two publication sites are in different scripts.
    const env = store();
    publishFixPlans({
      stories: [{
        ...laneStory('gotransit'),
        fixSiteAnalysis: [
          { file: 'src/gotransit.ts', reason: 'GOTRANSIT-SITE', fix: 'x' },
          { file: 'src/upexpress.ts', reason: 'UPEXPRESS-SITE', fix: 'x' },
          { file: 'src/metrolinx.ts', reason: 'METROLINX-SITE', fix: 'x' },
        ],
      }],
    }, env);
    const out = io.collect('AMSD-1', ['fix-plan'], env);
    expect(out).toContain('GOTRANSIT-SITE');
    expect(out, 'the merged union was published to a lane that names its own codeline')
      .not.toContain('UPEXPRESS-SITE');
  });

  it('a story with NO codeline publishes the flat list, as a single-lane run must', () => {
    const env = store();
    publishFixPlans({
      stories: [{ id: 'AMSD-1', fixSiteAnalysis: [{ file: 'src/a.ts', reason: 'FLAT-SITE', fix: 'x' }] }],
    }, env);
    expect(io.collect('AMSD-1', ['fix-plan'], env)).toContain('FLAT-SITE');
  });

  it('a codeline with an EXPLICITLY EMPTY entry publishes nothing, not the union', () => {
    // "This lane found nothing" is a real state and differs from "this lane has not run" — the
    // same distinction the lane-PRD scoping already makes. Falling back to the union here would
    // hand a lane every other lane's work.
    const env = store();
    publishFixPlans({
      stories: [{
        id: 'AMSD-1',
        codeline: 'gotransit',
        fixSiteAnalysis: [{ file: 'src/x.ts', reason: 'UNION-SITE', fix: 'x' }],
        fixSiteAnalysisPerCodeline: { gotransit: [] },
      }],
    }, env);
    expect(io.collect('AMSD-1', ['fix-plan'], env).trim(),
      'a lane that found nothing was handed the union').toBe('');
  });

  it('a codeline ABSENT from the map falls back to the flat list, never to nothing', () => {
    // A lane added later, or a first run. An empty plan would be a writer told to fix nothing.
    const env = store();
    publishFixPlans({
      stories: [{
        id: 'AMSD-1',
        codeline: 'newlane',
        fixSiteAnalysis: [{ file: 'src/x.ts', reason: 'FLAT-SITE', fix: 'x' }],
        fixSiteAnalysisPerCodeline: { gotransit: [{ file: 'g.ts', reason: 'G', fix: 'x' }] },
      }],
    }, env);
    expect(io.collect('AMSD-1', ['fix-plan'], env)).toContain('FLAT-SITE');
  });
});

describe('LANES DO NOT SHARE A STORE', () => {
  it('each lane store holds only its own lane plan', () => {
    const go = store();
    const up = store();
    publishFixPlans({ stories: [laneStory('gotransit')] }, go);
    publishFixPlans({ stories: [laneStory('upexpress')] }, up);

    expect(io.collect('AMSD-1', ['fix-plan'], go)).toContain('GOTRANSIT-SITE');
    expect(io.collect('AMSD-1', ['fix-plan'], go)).not.toContain('UPEXPRESS-SITE');
    expect(io.collect('AMSD-1', ['fix-plan'], up)).toContain('UPEXPRESS-SITE');
    expect(io.collect('AMSD-1', ['fix-plan'], up)).not.toContain('GOTRANSIT-SITE');
  });

  it('the orchestrator gives every lane its OWN store path', () => {
    // The parent exports AGENT_IO_DIR; without an explicit per-lane value the lanes inherit it and
    // all three read one store, defeating the per-lane LOG_DIR that exists because shared lane
    // state has already caused a false pass on unreviewed code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('node:fs')
      .readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    const laneInvocations = src.split('LOG_DIR="$_lane_log_dir"').length - 1;
    const laneStores = src.split('AGENT_IO_DIR="$_lane_log_dir/agent-io"').length - 1;
    expect(laneInvocations, 'the per-lane LOG_DIR wiring moved; this check is anchored on it')
      .toBeGreaterThan(0);
    expect(laneStores, `${laneInvocations} lane invocation(s) set LOG_DIR but only ${laneStores} `
      + 'set AGENT_IO_DIR — the rest inherit the parent store and read another lane plan')
      .toBe(laneInvocations);
  });
});

describe('PUBLICATION DOES NOT DEPEND ON THE SPEC PASS RUNNING', () => {
  // A resume routinely skips the spec pass. If publication lived inside it, a resumed run would
  // publish nothing, the plan would simply be absent, and the writer would go in blind — which
  // looks exactly like a run that never had a plan. This is checked by EXECUTING the publication
  // function the orchestrator defines, with the spec pass never invoked.
  it('the publish step is a standalone function, called outside the spec-pass branch', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    const src = fs.readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

    const start = src.indexOf('_publish_agent_outputs() {');
    expect(start, 'the publication step is gone or renamed').toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const fn = src.slice(start, end + 2);

    // It must NOT sit inside run_specification_pass.
    const specStart = src.indexOf('run_specification_pass() {');
    const specEnd = src.indexOf('\n}', specStart);
    expect(start > specStart && start < specEnd,
      'publication is inside the spec pass, so a resume that skips it publishes nothing').toBe(false);

    // And it must actually publish when executed with no spec pass anywhere in sight.
    const dir = mkdtempSync(join(tmpdir(), 'publish-fn-')); dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories: [{
        id: 'AMSD-1', codeline: 'gotransit',
        fixSiteAnalysisPerCodeline: {
          gotransit: [{ file: 'src/g.ts', reason: 'RESUMED-LANE-SITE', fix: 'x' }],
          upexpress: [{ file: 'src/u.ts', reason: 'OTHER-LANE-SITE', fix: 'x' }],
        },
      }],
    }));
    const ioDir = join(dir, 'io');
    execFileSync('bash', ['-c', `set -uo pipefail
      SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
      NODE_CMD=${JSON.stringify(process.execPath)}
      PRD_FILE=${JSON.stringify(prd)}
      export AGENT_IO_DIR=${JSON.stringify(ioDir)}
      warning() { printf '%s\\n' "$*" >&2; }
      ${fn}
      _publish_agent_outputs`], { encoding: 'utf8' });

    const out = io.collect('AMSD-1', ['fix-plan'], { AGENT_IO_DIR: ioDir });
    expect(out, 'a resumed run published no plan').toContain('RESUMED-LANE-SITE');
    expect(out, "a resumed lane received another lane's plan").not.toContain('OTHER-LANE-SITE');
  });
});
