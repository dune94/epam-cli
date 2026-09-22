/**
 * THE WALL A STORY ACTUALLY GETS — asserted where it is enforced, not where it is declared.
 *
 * 2026-09-22: the engine's walls were quadrupled to four hours, the loader was taught to export
 * them, both were tested, both passed — and regintel resume 6 killed REGI-004-A and REGI-010-B at
 * 600s anyway. The tests proved the declaration and the export; nothing proved the number the
 * watchdog would actually apply to a story. Two layers sat in between: the orchestrator process
 * (which owns run_story_with_watchdog) never loaded the settings, and a project's config.env pinned
 * EPAM_STORY_TIMEOUT_SECS=600, which beats any engine default.
 *
 * This resolves the wall the way the watchdog does — same lib, same order, a project config.env in
 * place — and asserts hours. A value is proven where it is consumed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The effective wall for one story, resolved exactly as the orchestrator does before it runs one. */
function effectiveWall(opts: { effort?: string; projectConfigEnv?: string } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'wall-real-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir);
  const cfgDir = join(d, 'project'); mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, 'llm-settings.json'), JSON.stringify({ ladders: {} }));
  if (opts.projectConfigEnv !== undefined) writeFileSync(join(cfgDir, 'config.env'), opts.projectConfigEnv);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', effort: opts.effort || 'medium', model: 'MiniMax-M3' }] }));
  const stub = join(d, 'claude.sh');
  writeFileSync(stub, '#!/usr/bin/env bash\nexit 0\n');
  const r = spawnSync('bash', ['-c', `
    set -uo pipefail
    SCRIPT_DIR="${SCRIPTS}"; AUTOMATION_DIR="${SCRIPTS}/.."; LOG_DIR="${logDir}"
    PRD_FILE="${prd}"; MAIN_PRD_FILE="${prd}"; CLAUDE_SH="${stub}"; EPAM_PROJECT_CONFIG_DIR="${cfgDir}"
    log(){ :; }; warning(){ :; }; error(){ :; }; info(){ :; }; success(){ :; }
    # As the orchestrator does: the project's own env, then the declarations, then the watchdog.
    [ -f "$EPAM_PROJECT_CONFIG_DIR/config.env" ] && set -a && . "$EPAM_PROJECT_CONFIG_DIR/config.env" && set +a
    . "$SCRIPT_DIR/lib/model-ladder.sh"; load_llm_settings_json
    . "$SCRIPT_DIR/lib/story-retry-state.sh"; . "$SCRIPT_DIR/lib/story-watchdog.sh"
    # The watchdog's own resolution, with the invocation replaced by a report of the wall it chose.
    timeout(){ printf 'WALL=%s\\n' "$1"; return 0; }
    run_story_with_watchdog S-1 "${logDir}/main-S-1.log" >/dev/null 2>&1 || true
    run_story_with_watchdog S-1 "${logDir}/main-S-1.log" 2>/dev/null | grep -m1 '^WALL='
  `], { encoding: 'utf8', timeout: 120_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const wall = Number(/WALL=(\d+)/.exec(out)?.[1] ?? 0);
  return { wall, out };
}

describe('the second clock — the one wrapped around each attempt inside claude.sh', () => {
  it('honours the declared floor too, so a project pin cannot kill an attempt twice', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-attempt.sh'), 'utf8');
    const at = src.indexOf('_timeout_prefix=');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 900);
    expect(block, 'the attempt wall is taken raw from the env — a project pin kills every attempt')
      .toMatch(/_attempt_floor|EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS/);
  });
});

describe('the wall a story actually gets', () => {
  it('a medium story gets hours, not minutes — resolved where it is enforced', () => {
    const r = effectiveWall({ effort: 'medium' });
    expect(r.wall, `the watchdog resolved ${r.wall}s:\n${r.out.slice(-600)}`).toBeGreaterThanOrEqual(3600);
  });

  it('a low-effort story too — the cheapest tier is still hours', () => {
    expect(effectiveWall({ effort: 'low' }).wall).toBeGreaterThanOrEqual(3600);
  });

  it("a project's own config.env cannot put it back under an hour unnoticed", () => {
    // regintel's config.env pinned EPAM_STORY_TIMEOUT_SECS=600 and beat every engine default.
    const r = effectiveWall({ effort: 'medium', projectConfigEnv: 'EPAM_STORY_TIMEOUT_SECS=600\n' });
    expect(r.wall, 'a project pin silently reinstated the wall that killed REGI-004-A and REGI-010-B').toBeGreaterThanOrEqual(3600);
  });

  it('no project in this repo ships such a pin', () => {
    const projects = join(ROOT, 'orchestrations/projects');
    const offenders: string[] = [];
    for (const p of readdirSync(projects)) {
      const f = join(projects, p, 'config.env');
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^EPAM_STORY_TIMEOUT_SECS=(\d+)/.exec(line.trim());
        if (m && Number(m[1]) < 3600) offenders.push(`${p}=${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
