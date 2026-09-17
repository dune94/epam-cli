/**
 * A FRESH RUN INHERITS NO OTHER RUN'S ESTATE.
 *
 * skyscanner greenfield, run 20260916T222133Z on the claude set: the mint was told its codelines
 * were /projects/mock3/mock-a and mock-b — a BROWNFIELD project's repositories — because
 * orchestrations/logs/codeline-discovery.json was left by a mock3 run on 2026-09-14 and
 * mint-agents-step.js reads that file before anything else. It minted two read-only investigators
 * for repositories the project does not have, the roster review refused a roster with no
 * implementer (correctly), and the run aborted before its first story.
 *
 * pre-run-reset.sh clears the fetched-document caches and the estate survey for exactly this
 * reason ("no other run's documents or survey evidence reach this run's prompts"); the discovery
 * result and the mint's own inputs record are the same kind of artefact and were not on the list.
 * This EXECUTES the real pre-run-reset.sh against a temp LOG_DIR: a fresh run clears them, a
 * resume keeps them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function reset(env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'reset-estate-')); dirs.push(d);
  const logs = join(d, 'logs'); mkdirSync(logs);
  const prd = join(d, 'x-prd.json'); writeFileSync(prd, JSON.stringify({ stories: [] }));
  const dash = join(d, 'dash'); mkdirSync(dash);
  writeFileSync(join(logs, 'codeline-discovery.json'), JSON.stringify({ codelines: [{ name: 'mocka', path: '/projects/mock3/mock-a' }] }));
  writeFileSync(join(logs, 'mint-inputs.json'), JSON.stringify({ codelineRepo: '/projects/mock3/mock-a' }));
  writeFileSync(join(logs, 'estate-survey.json'), JSON.stringify({ repositories: [] }));
  const r = spawnSync('bash', [RESET, '--prd', prd, '--log-dir', logs], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, COMPOSE_OVERRIDE: join(d, 'override.yml'), DASHBOARD_STATE_DIR: dash, ...env },
  });
  return { logs, out: `${r.stdout}\n${r.stderr}` };
}

describe('a fresh run inherits no other run\'s estate', () => {
  it('a FRESH run clears the previous run\'s codeline discovery and mint inputs (and, as before, the survey)', () => {
    const t = reset({ EPAM_RESUME_RUN: '' });
    expect(t.out).toMatch(/PRE_RUN_RESET_STATE_CLEARED/);
    expect(existsSync(join(t.logs, 'estate-survey.json')), 'the survey sweep regressed').toBe(false);
    expect(existsSync(join(t.logs, 'codeline-discovery.json')), 'a previous run\'s codeline discovery would name this run\'s estate').toBe(false);
    expect(existsSync(join(t.logs, 'mint-inputs.json')), 'a previous run\'s mint inputs survive').toBe(false);
    // CLEARED FROM THE LIVE DIR, KEPT AS EVIDENCE: the seam harness replays a failed run from these
    // files, and `rm -f` destroyed run 20260916T234139Z's the moment a test executed this reset.
    const archives = readdirSync(join(t.logs, 'archive')).filter((d) => d.startsWith('pre-run-'));
    expect(archives.length).toBeGreaterThan(0);
    for (const f of ['codeline-discovery.json', 'mint-inputs.json', 'estate-survey.json']) {
      expect(archives.some((a) => existsSync(join(t.logs, 'archive', a, f))), `${f} was deleted, not archived`).toBe(true);
    }
  });

  it('a RESUME keeps its own run\'s discovery and mint inputs', () => {
    const t = reset({ EPAM_RESUME_RUN: '20260916T222133Z' });
    expect(existsSync(join(t.logs, 'codeline-discovery.json'))).toBe(true);
    expect(existsSync(join(t.logs, 'mint-inputs.json'))).toBe(true);
    expect(existsSync(join(t.logs, 'estate-survey.json'))).toBe(true);
  });
});
