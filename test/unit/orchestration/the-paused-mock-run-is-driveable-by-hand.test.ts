/**
 * THE OPERATOR-DRIVEN PAUSED RUN — 142 lines, no test, and the pauses in it were broken.
 *
 * Its own header distinguishes it from the vitest e2e: that test runs both passes back to back to
 * prove the mechanism, which is useful for CI and useless for driving the thing by hand, because it
 * resumes itself and never waits for anyone. This script is the workflow — start, stop before the
 * writer, leave a checkpoint, resume later by run number.
 *
 * Three of its modes exist SO THEY CAN BE ASSERTED rather than discovered in a run: --where reports
 * a workspace location without creating anything, --seed builds only the fixture with no Jira stub,
 * no pipeline, no LLM and no spend, and --list shows the checkpoints available to resume. Its own
 * comment says --seed exists to catch the live 2026-08-03 failure before it cost a run.
 *
 * Everything below uses those modes. Nothing here starts a pipeline or spends anything.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/mock1-paused-run.sh');

function mock1(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 180_000, cwd: join(__dirname, '../../..'),
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('the paused mock run can be inspected without starting one', () => {
  it('--where reports the workspace location and creates nothing', () => {
    // It exists so the location can be asserted in a test rather than discovered in a run.
    const r = mock1(['--where']);
    expect(r.code, r.out.slice(0, 300)).toBe(0);
    expect(r.out, 'it did not report a workspace path').toMatch(/workspace/);
    expect(r.out, 'the reported path names no run').toMatch(/run-id|<run/i);
  }, 240_000);

  it('--list exits cleanly whether or not any checkpoint exists', () => {
    const r = mock1(['--list']);
    expect(r.code, 'listing checkpoints failed').toBe(0);
  }, 240_000);

  it('--seed REQUIRES a target directory rather than choosing one', () => {
    // Choosing one would write a fixture into a directory nobody named.
    const r = mock1(['--seed']);
    expect(r.code, 'it seeded a directory nobody named').not.toBe(0);
    expect(r.out).toMatch(/requires a target directory/);
  }, 240_000);

  it('--seed builds the fixture, with no Jira stub, no pipeline and no spend', () => {
    // Its purpose: a test can run against the REAL fixture and prove the test file is discovered —
    // the check that would have caught the live 2026-08-03 failure before it cost a run.
    // The target is CREATED by the seed. Handing it a directory that already exists trips the
    // workspace guard, which is right: a seed into a populated tree would mix a fixture with
    // whatever was there.
    // The seed sources live WITH the project ($PROJECT_CONFIG_DIR/seed), deliberately: a seed file
    // written by a heredoc in the launcher would be a project fact inside the pipeline that cannot
    // be opened, linted or type-checked where it sits. So this mode needs a project even though it
    // spends nothing.
    const project = join(__dirname, '../../../orchestrations/projects/hello-dolly');
    const dir = join(mkdtempSync(join(tmpdir(), 'seed-')), 'fixture');
    const r = mock1(['--seed', dir], { EPAM_PROJECT_CONFIG_DIR: project });
    expect(r.code, `seeding failed: ${r.out.slice(0, 500)}`).toBe(0);
    expect(existsSync(dir) && readdirSync(dir).length,
      'the seed produced no fixture at all').toBeTruthy();
  }, 240_000);

  it('--resume REQUIRES a run number rather than guessing the latest', () => {
    // Guessing would resume a different run than the operator means, and a resume writes.
    const r = mock1(['--resume']);
    expect(r.code, 'it resumed a run nobody named').not.toBe(0);
    expect(r.out).toMatch(/requires a run number/);
  }, 240_000);

  it('an unknown option is refused rather than starting a run', () => {
    // A mis-typed --where would otherwise fall through to starting the pipeline.
    const r = mock1(['--not-a-flag']);
    expect(r.code, 'an unknown option started a run').not.toBe(0);
    expect(r.out).toMatch(/unknown option/);
  }, 240_000);

  it('--where works WITHOUT a project, because it starts nothing', () => {
    // The project check used to run before argument parsing, so --where, --list, --seed and every
    // bad-argument refusal died on it — and the default it derived no longer existed, because it
    // scraped a line shape tier3-mock-run.sh had stopped using. The whole script refused every
    // invocation. The check now runs after parsing, and only the modes that need a project pay for it.
    const r = mock1(['--where'], { EPAM_PROJECT_CONFIG_DIR: '' });
    expect(r.code, '--where still requires a project it does not use').toBe(0);
    expect(r.out).toMatch(/workspace/);
  }, 240_000);

  it('but a mode that DOES need a project refuses by name when it is missing', () => {
    const r = mock1(['--seed', join(mkdtempSync(join(tmpdir(), 'seed-')), 'x')],
      { EPAM_PROJECT_CONFIG_DIR: '/no/such/project' });
    expect(r.code, 'it seeded from a project that does not exist').not.toBe(0);
    expect(r.out, 'the refusal does not name what would fix it').toMatch(/EPAM_PROJECT_CONFIG_DIR/);
  }, 240_000);

  it('it sources the pause library, and that library brings its own is_truthy', () => {
    // This script sources run-checkpoint.sh without flags.sh, so is_truthy was undefined and NEITHER
    // PAUSE FIRED in a script whose entire purpose is a paused run. The library now sources it.
    const src = require('node:fs').readFileSync(SCRIPT, 'utf8');
    expect(src, 'it no longer uses the checkpoint library at all').toMatch(/run-checkpoint\.sh/);
    const lib = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh'), 'utf8');
    expect(lib, 'the pause library stopped sourcing the flags it calls').toMatch(/flags\.sh/);
  });
});
