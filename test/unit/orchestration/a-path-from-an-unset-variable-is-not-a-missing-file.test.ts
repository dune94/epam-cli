/**
 * A PATH BUILT FROM AN UNSET VARIABLE IS NOT A MISSING FILE.
 *
 * Two callers resolve the project's LLM settings like this:
 *
 *     "${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json"
 *
 * With the variable unset that is `/llm-settings.json` — the filesystem root. The loader then
 * reports, truthfully and uselessly:
 *
 *     [model-ladders] settings file not found: /llm-settings.json — no ladder chains exported
 *
 * No ladders are exported, so the next seam refuses to resolve a model and the run stops. The
 * message points at a path that has never existed on any machine, which sends whoever reads it
 * looking for a file rather than for the variable that was never set.
 *
 * It is the same defect as `--provider ${EMPTY}` one layer over: an empty value interpolated into
 * a string produces something structurally wrong rather than something absent. And it is the same
 * lesson as the error that blamed "a transport or budget failure" — say what was observed, never a
 * cause that has not been established.
 *
 * The assertion runs the real loader and reads what it printed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');

/**
 * EVERY caller, discovered rather than listed — fixing the two sites that surfaced and leaving
 * twenty-one twins is exactly how this class survives a fix.
 */
function callers(): string[] {
  const r = spawnSync('bash', ['-c',
    `cd ${JSON.stringify(REPO)} && grep -rl 'EPAM_PROJECT_CONFIG_DIR' orchestrations/scripts --include=*.sh`],
    { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').split('\n').filter(Boolean);
}

/** Run the loader with no project config dir, as a child that lost its env would. */
function loadWithNoConfigDir() {
  return spawnSync('bash', ['-c', `
    cd ${JSON.stringify(REPO)}
    . orchestrations/scripts/lib/model-ladders.sh
    export_model_ladders "\${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json"
  `], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: '', EPAM_LLM_SETTINGS_FILE: '' },
  });
}

describe('a path built from an unset variable is not a missing file', () => {
  it('the loader does report something — otherwise there is nothing to judge', () => {
    const r = loadWithNoConfigDir();
    expect((r.stderr || '').trim().length, 'the loader said nothing at all').toBeGreaterThan(0);
  }, 60_000);

  it('it does not report a path at the filesystem root as a missing file', () => {
    const r = loadWithNoConfigDir();
    expect(r.stderr, 'the loader blamed /llm-settings.json, a path that has never existed')
      .not.toMatch(/not found: \/[a-z-]+\.json/);
  }, 60_000);

  it('it names the variable that was not set', () => {
    const r = loadWithNoConfigDir();
    expect(r.stderr, 'the message does not name the unset variable, so it points nowhere')
      .toMatch(/EPAM_PROJECT_CONFIG_DIR|EPAM_LLM_SETTINGS_FILE|no project/i);
  }, 60_000);

  it('every caller guards the interpolation, not just the one that was noticed', () => {
    // Fixing the site that surfaced and leaving its twin is how this class survives.
    const found = callers();
    expect(found.length, 'no callers found at all — the sweep proves nothing').toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of found) {
      const src = readFileSync(join(REPO, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (/\$\{EPAM_PROJECT_CONFIG_DIR:-\}\//.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, 'these build a path from a possibly-unset variable').toEqual([]);
  });
});
