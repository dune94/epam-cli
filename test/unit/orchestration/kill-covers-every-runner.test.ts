/**
 * `kill-tier3-run.sh` must be able to stop EVERY tier3 runner.
 *
 * Two defects found 2026-07-25 by a static parameter audit — neither had ever
 * surfaced, because you only discover a kill that does not kill by watching a run
 * you "stopped" keep spending money:
 *
 *  1. tier3-skyscanner-app-run.sh:51 wrote the TRAVEL-APP pid file
 *     (`TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-travel-app-run.pid}"`) — a
 *     copy-paste. Two runners sharing one pid file means the second launch
 *     overwrites it and the kill targets the wrong process group.
 *
 *  2. kill-tier3-run.sh's orphan sweep pattern listed only
 *     `tier3-travel-app-run\.sh`. Metrolinx and skyscanner top-level runners were
 *     absent, so killing a metrolinx run left the runner alive to relaunch
 *     phases — with the pid-file default also pointing at travel-app, the kill
 *     could miss entirely.
 *
 * This matters beyond tidiness: the user's standing rule is that they approve every
 * launch AND every kill. A kill command that silently fails to kill breaks that
 * control, and the surviving process keeps billing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const read = (f: string) => readFileSync(join(SCRIPTS, f), 'utf8');

const runners = readdirSync(SCRIPTS).filter(f => /^tier3-.*-run\.sh$/.test(f));
const killSrc = read('kill-tier3-run.sh');

const pidFileOf = (r: string) => {
  const m = read(r).match(/^TIER3_PID_FILE="?\$\{TIER3_PID_FILE:-([^}"]+)\}/m);
  return m ? m[1] : null;
};

describe('kill-tier3-run.sh — covers every runner', () => {
  it('finds the runners and the kill script', () => {
    expect(runners.length).toBeGreaterThan(1);
    expect(killSrc).toMatch(/orphan_pattern=/);
  });

  it('no two runners share a pid file', () => {
    const byPid = new Map<string, string[]>();
    for (const r of runners) {
      const p = pidFileOf(r);
      if (!p) continue;
      byPid.set(p, [...(byPid.get(p) ?? []), r]);
    }
    const shared = [...byPid.entries()].filter(([, rs]) => rs.length > 1);
    expect(shared.map(([p, rs]) => `${rs.join(' + ')} -> ${p}`),
      'a shared pid file means the kill targets the wrong process group').toEqual([]);
  });

  it("each runner's pid file is named after that runner", () => {
    const wrong = runners
      .map(r => ({ r, p: pidFileOf(r) }))
      .filter(({ r, p }) => p && !p.includes(r.replace(/\.sh$/, '')))
      .map(({ r, p }) => `${r} -> ${p}`);
    expect(wrong, 'pid file does not match its runner (copy-paste)').toEqual([]);
  });

  /**
   * 2026-08-06: the sweep pattern no longer LISTS the runners — a hardcoded list put a
   * client's project name into engine source, and a new project silently went unswept
   * until someone remembered to add it. The launchers are now discovered from disk.
   *
   * So this asserts the PROPERTY rather than the text: build the pattern the way the
   * script does, and require that it matches every runner actually present. A list in the
   * source would satisfy the old assertion while missing a runner added yesterday; this
   * one cannot.
   */
  it('the orphan sweep pattern MATCHES every runner present on disk', () => {
    const built = execFileSync('bash', ['-c', `
      _KILL_SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
      _launchers=""
      for _l in "$_KILL_SCRIPT_DIR"/tier[0-9]*-*-run.sh "$_KILL_SCRIPT_DIR"/mock*run.sh; do
        [ -f "$_l" ] || continue
        _launchers="\${_launchers}orchestrations/scripts/$(basename "$_l" | sed 's/\\./\\\\./g')|"
      done
      printf '%s' "$_launchers"
    `], { encoding: 'utf8' });

    const unmatched = runners.filter((r) => !new RegExp(built.replace(/\|$/, '')).test(`orchestrations/scripts/${r}`));
    expect(unmatched, 'these runners survive a kill and keep relaunching phases').toEqual([]);
  });

  it('the pattern is DERIVED, not written down — no runner is named in the source', () => {
    const named = runners.filter((r) => killSrc.includes(r));
    expect(
      named,
      'a hardcoded runner list puts a project name in engine source and silently misses ' +
        'any launcher added later',
    ).toEqual([]);
  });
});
