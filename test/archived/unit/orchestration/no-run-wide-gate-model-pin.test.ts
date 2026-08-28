/**
 * THE LADDER DECIDES EVERY SEAM'S MODEL. THERE IS NO RUN-WIDE PIN.
 *
 * `ORCH_GATE_MODEL` was read in 47 places across 13 files — gates, codeline discovery, the AC
 * gate, reviews, the TC writer, the topology router, contextualize, spec-mode. For every one of
 * those seams it was not a FALLBACK, it was the ONLY channel: `resolveOrRefuse` takes an ordered
 * source list and the ladder was not in it.
 *
 * So the pipeline had two model systems at once — the ladder for story seams, and one run-wide
 * pin for everything else. `.env:21` set `ORCH_GATE_MODEL=z-ai/glm-5.2`, which is why a
 * MOCKSERVER run asked for an OpenRouter model and died: nothing else could supply one.
 *
 * That is the same defect run-agent-orchestration.sh names in its own words — "a pin, not a
 * ladder" — left live for 47 call sites after the story path was migrated.
 *
 * The replacement is the seam's own ladder: seam_model_or_fail (shell) and the seam's declared
 * position (JS). Both refuse loudly rather than substitute.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PIN = 'ORCH_GATE_MODEL';

function scriptFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!['test', 'node_modules', 'tools'].includes(e.name)) walk(p); }
      else if (/\.(sh|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(SCRIPTS);
  return out;
}

/** Executable references only — a comment may name it as history. */
function pinRefs(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !/^\s*(#|\/\/|\*)/.test(l))
    .filter(({ l }) => l.includes(PIN))
    .map(({ l, i }) => `${file.replace(ROOT + '/', '')}:${i + 1}  ${l.trim().slice(0, 60)}`);
}

describe('no run-wide gate model pin', () => {
  it('finds scripts to scan — otherwise this passes vacuously', () => {
    expect(scriptFiles().length).toBeGreaterThan(20);
  });

  it('no ENGINE script reads or writes the run-wide model pin', () => {
    const offenders = scriptFiles().flatMap(pinRefs);
    expect(offenders, `${PIN} is a run-wide pin; the seam's ladder decides`).toEqual([]);
  });

  it('the root .env does not pin a model either', () => {
    const env = join(ROOT, '.env');
    if (!existsSync(env)) return;
    const pinned = readFileSync(env, 'utf8').split('\n')
      .filter((l) => /^\s*(ORCH_GATE_MODEL|EPAM_MODEL|ESCALATION_MODEL)\s*=\s*\S/.test(l));
    expect(pinned, '.env outranks the ladder for every seam that reads it').toEqual([]);
  });

  it('the ladder-based replacement exists, so removal has somewhere to go', () => {
    const seamLadder = readFileSync(join(SCRIPTS, 'lib/seam-ladder.sh'), 'utf8');
    expect(seamLadder).toMatch(/seam_model_or_fail\(\)/);
  });
});
