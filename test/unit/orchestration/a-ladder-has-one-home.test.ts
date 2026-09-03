/**
 * A LADDER IS DECLARED IN THE SETTINGS LAYER, NEVER PINNED IN A COMMITTED config.env.
 *
 * The ladder design came after skyscanner. metrolinx, mock3 and hello-dolly were migrated to
 * a declarative llm-settings.json; skyscanner was not, and the code honouring the old
 * mechanism was left in place — so nothing ever failed and the drift stayed invisible until
 * all four projects were resolved side by side.
 *
 * model-ladders.sh: `[ -n "${!_var:-}" ] && continue` — an already-set chain outranks the
 * declaration. That guard is RIGHT for an operator overriding at launch. It is WRONG as a
 * home for a committed declaration: two homes for one value is the condition the inheritance
 * work exists to end, and it produces PARTIAL inheritance — some tiers pinned, others
 * inherited — which looks configured and is not.
 *
 * The runtime override is untouched. Only the committed pin is refused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const PROJECTS = join(__dirname, '../../../orchestrations/projects');

/** A pin that is ACTIVE: not commented out, and assigning a non-empty value. */
function activeTierPins(configEnv: string): string[] {
  return readFileSync(configEnv, 'utf8')
    .split('\n')
    .filter((l) => /^\s*EPAM_MODEL_LADDER_[A-Z_]+\s*=/.test(l))
    .filter((l) => {
      const v = l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      return v.length > 0;
    })
    .map((l) => l.trim());
}

const projects = readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/** A launcher line that ASSIGNS a per-tier ladder a non-empty default. */
function launcherTierPins(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /EPAM_MODEL_LADDER_[A-Z_]+=/.test(l))
    // `${VAR:-}` with an empty default pins nothing — it only declares the name.
    .filter((l) => !/EPAM_MODEL_LADDER_[A-Z_]+="\$\{EPAM_MODEL_LADDER_[A-Z_]+:-\}"/.test(l))
    .map((l) => l.trim());
}

describe('a launcher declares no ladder either', () => {
  // THE SAME DEFECT, ONE LAYER OUT. B6 removed committed ladder pins from config.env; two
  // launchers still carried them, and model-ladders.sh treats an already-set chain as an
  // operator override that OUTRANKS the declaration. So a launcher pin silently beat the
  // project's llm-settings.json.
  //
  // It had already rotted: the pins interpolate ${ESCALATION_MODEL}, which config stopped
  // setting when the ladder took over, so the chain resolved to hops with EMPTY destinations
  // — "MiniMax-M3=" — and that malformed chain would still have won.
  const launchers = readdirSync(SCRIPTS).filter((f) => /^tier3-.*\.sh$/.test(f));

  it('finds launchers, so this cannot pass vacuously', () => {
    expect(launchers.length).toBeGreaterThan(1);
  });

  for (const f of launchers) {
    it(`${f}: pins no per-tier ladder`, () => {
      expect(launcherTierPins(join(SCRIPTS, f)),
        `${f} pins a ladder that outranks the project's declaration`).toEqual([]);
    });
  }
});

describe('a ladder has one home', () => {
  it('finds the projects, so a rename cannot make this suite vacuous', () => {
    expect(projects.length).toBeGreaterThan(0);
    expect(projects).toContain('skyscanner');
  });

  for (const p of projects) {
    const cfg = join(PROJECTS, p, 'config.env');
    if (!existsSync(cfg)) continue;

    it(`${p}: declares no per-tier ladder pin in its committed config.env`, () => {
      expect(activeTierPins(cfg)).toEqual([]);
    });
  }

  for (const p of projects) {
    const cfg = join(PROJECTS, p, 'config.env');
    const settings = join(PROJECTS, p, 'llm-settings.json');
    if (!existsSync(cfg)) continue;

    it(`${p}: if it declares ladders anywhere, they are in the settings layer`, () => {
      const pinned = activeTierPins(cfg).length > 0;
      // A project may legitimately declare no ladders at all and inherit the base.
      // What it may NOT do is declare them in config.env.
      expect(pinned, `${p} pins a ladder in config.env: migrate it to llm-settings.json`).toBe(false);
      if (existsSync(settings)) {
        const j = JSON.parse(readFileSync(settings, 'utf8'));
        if (j.ladders) expect(Object.keys(j.ladders).length).toBeGreaterThan(0);
      }
    });
  }
});
