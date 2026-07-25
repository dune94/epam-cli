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

  it('the orphan sweep pattern names every tier3 runner', () => {
    const missing = runners.filter(r => !killSrc.includes(r.replace(/\./g, '\\.')));
    expect(missing, 'these runners survive a kill and keep relaunching phases').toEqual([]);
  });
});
