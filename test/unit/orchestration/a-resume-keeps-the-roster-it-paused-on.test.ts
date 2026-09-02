/**
 * A RESUME KEEPS THE ROSTER IT PAUSED ON.
 *
 * pre-run-reset deletes <project>/roster.json on every launch, and the reason it gives is right for
 * a NEW run: "a roster that survives is a stored artefact with a lifetime — the next run's agents
 * would be whoever the LAST run happened to derive, and nothing would ever ask whether canonical
 * had moved since."
 *
 * A RESUME IS NOT THE NEXT RUN. It is the same run, continuing from its own checkpoint. The roster
 * it holds was derived by that run, reviewed at its own pause, and shown to the operator for
 * approval — which is the entire purpose of pausing there. Deleting it makes the checkpoint
 * meaningless.
 *
 * The reset already draws exactly this distinction for other run state:
 *
 *     if [ "$_IS_RESUMED_RUN" = "1" ]; then
 *         info "  Resuming — keeping this run's own fetched documents and estate survey"
 *
 * The roster block simply never asked. So every resume re-derived a roster it had just been told
 * to carry over, and the log said both things at once:
 *
 *     [mint-step] roster carried over from 20260901T224029Z — reviewed in that run, not re-reviewed here
 *     [mint-step] [roster] accepted 48 agent(s)          <- the specialiser had just run again
 *
 * THREE COSTS, all of which landed. A paid roster-specialiser call, ~13 minutes of wall clock. A
 * roster that differs from the reviewed one, so the operator approved something the run then
 * replaced. And every roster-keyed prompt invalidated, forcing a stage the checkpoint existed to
 * skip — 17 of 39 regenerated on the 2026-09-01 resume for no reason but this.
 *
 * The guard that must survive: a NEW run still starts from canonical. Absence is the correct state
 * at that point, and "derived every launch" stays enforceable rather than aspirational.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(process.cwd(), 'orchestrations/scripts/pre-run-reset.sh');
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/** A project whose roster was derived and reviewed at a pause. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'resume-roster-'));
  cleanup.push(root);
  const automationDir = join(root, 'orchestrations');
  const logDir = join(automationDir, 'logs');
  const cfg = join(automationDir, 'projects/metrolinx');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(join(automationDir, 'agents'), { recursive: true });
  writeFileSync(join(automationDir, 'agents/profiles.json'), JSON.stringify({ 'typescript-engineer': 'x' }));

  const roster = join(cfg, 'roster.json');
  writeFileSync(roster, JSON.stringify({
    agents: { 'checkout-form-engineer': { persona: 'minted and reviewed at the pause', kind: 'implementer' } },
  }));
  const prd = join(root, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-1919' }] }));
  return { root, automationDir, logDir, cfg, roster, prd };
}

function run(fx: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  // --prd is REQUIRED by the script; without it the reset exits 1 before reaching the roster
  // block, and every "it survived" assertion below would pass on a reset that never ran.
  const r = spawnSync('bash', [SCRIPT, '--prd', fx.prd], {
    encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env,
      AUTOMATION_DIR: fx.automationDir,
      LOG_DIR: fx.logDir,
      EPAM_PROJECT_CONFIG_DIR: fx.cfg,
      WORKING_PRD: fx.prd,
      ...extraEnv,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('a resume keeps the roster it paused on', () => {
  it('the fixture is real AND the reset actually runs', () => {
    // Non-vacuity, both halves. The first version checked only that the file existed; the reset
    // was exiting 1 on a missing --prd, so "a resume keeps it" passed while nothing had run.
    const fx = fixture();
    expect(existsSync(fx.roster), 'the fixture wrote no roster').toBe(true);
    const r = run(fx);
    expect(r.code, `the reset did not run cleanly, so nothing below is a fact:\n${r.out}`).toBe(0);
  });

  it('A NEW RUN CLEARS IT — derived every launch, from canonical', () => {
    // The guard that must not be lost. Without it a project inherits whoever the last run derived.
    const fx = fixture();
    run(fx);
    expect(existsSync(fx.roster),
      'a NEW run kept a roster from a previous run — it would inherit those agents')
      .toBe(false);
  });

  it('A RESUME KEEPS IT — the checkpoint is what the operator approved', () => {
    const fx = fixture();
    run(fx, { EPAM_RESUME_RUN: '20260902T022134Z' });
    expect(existsSync(fx.roster),
      'the resume deleted the roster it was told to carry over, so the run must pay a '
      + 'specialiser call to re-derive one the operator never saw')
      .toBe(true);
  });

  it('and the roster it keeps is UNCHANGED — carried over, not rebuilt', () => {
    const fx = fixture();
    const before = readFileSync(fx.roster, 'utf8');
    run(fx, { EPAM_RESUME_RUN: '20260902T022134Z' });
    expect(readFileSync(fx.roster, 'utf8'),
      'the resume altered the reviewed roster').toBe(before);
  });

  it('AND THE MINT REUSES IT — a kept roster that is re-derived was kept for nothing', async () => {
    // Keeping the file is half the fix. buildProjectRoster called the specialiser unconditionally,
    // so the roster survived the reset and was immediately overwritten by a paid call.
    //
    // THE FILE'S PRESENCE IS THE SIGNAL. pre-run-reset deletes it on every NEW run, so a roster
    // still on disk when the mint starts can only have been kept by a resume. No run id is needed
    // here; the reset is the authority on lifetime and this honours what it left.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lib = require(join(process.cwd(), 'orchestrations/scripts/lib/project-roster.js'));
    const fx = fixture();
    const canonical = join(fx.root, 'canonical.json');
    writeFileSync(canonical, JSON.stringify({ 'typescript-engineer': 'be minimal' }));
    // A settled roster already on disk, holding what the operator approved.
    writeFileSync(lib.projectRosterPath(fx.cfg), JSON.stringify({
      agents: {
        'typescript-engineer': {
          persona: 'be minimal', kind: 'seam', ancestor: 'typescript-engineer',
          derivedFromSha256: lib.personaDigest('be minimal'), rationale: 'approved at the pause',
        },
      },
    }));

    let produceCalls = 0;
    const out = await lib.buildProjectRoster({
      canonicalPath: canonical,
      logDir: fx.logDir,
      projectConfigDir: fx.cfg,
      produce: async () => { produceCalls += 1; },
      log: () => {},
    });
    expect(produceCalls,
      'the specialiser ran even though a settled roster was already on disk — the resume paid for '
      + 'a roster the operator never reviewed').toBe(0);
    expect(out.agents['typescript-engineer'].rationale,
      'the returned roster is not the one that was on disk').toBe('approved at the pause');
  });

  it('the reset still succeeds in both modes', () => {
    const a = fixture(); const b = fixture();
    expect(run(a).code, 'the reset failed on a new run').toBe(0);
    expect(run(b, { EPAM_RESUME_RUN: 'X' }).code, 'the reset failed on a resume').toBe(0);
  });
});
