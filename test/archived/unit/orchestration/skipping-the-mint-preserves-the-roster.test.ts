/**
 * SKIPPING THE MINT MUST PRESERVE WHAT THE MINT LAST PRODUCED.
 *
 * WRITTEN BEFORE THE FIX. 2026-08-14.
 *
 * A writer re-run does not re-mint: re-minting proposes against an existing roster, the merge is
 * additive, and the agents change under a story mid-stream. So the roster the mint produced has
 * to survive to the next run.
 *
 * It does not. Every launch destroys it twice:
 *
 *   tier3-*-run.sh   copies profiles.json.original over profiles.json — the generic base state,
 *                    wiping the minted roster
 *   pre-run-reset.sh deletes project-roles.json and project-investigators.json, guarded ONLY by
 *                    EPAM_RESUME_RUN
 *
 * So a writer-only launch starts with no minted roster and no registries, and on 2026-08-13 the
 * run was only unblocked by hand-authoring replacements — which is authoring an agent artefact,
 * and is not permitted.
 *
 * THE RULE: the same protection a resume already gets applies whenever the mint is skipped. The
 * pipeline preserves what an agent produced; nobody curates it by hand.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const LAUNCHER = join(ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL registry-deletion block with a given environment. */
function resetRegistries(env: Record<string, string>): { cfg: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mint-preserve-')); dirs.push(dir);
  const cfg = join(dir, 'project');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'project-roles.json'), '{"roles":["minted-engineer"]}');
  writeFileSync(join(cfg, 'project-investigators.json'), '{"investigators":["minted-investigator"]}');

  const src = readFileSync(RESET, 'utf8');
  const start = src.indexOf('_IS_RESUME=0');
  expect(start, 'the resume guard moved — this test is anchored on it').toBeGreaterThan(-1);
  const end = src.indexOf('\ndone', src.indexOf('for _rf in', start));
  const block = src.slice(start, end + 5);

  // THE DECISION MOVED ABOVE THIS BLOCK; THE REQUIREMENT DID NOT.
  //
  // "is this a resume" is now asked once, near the top, because the run-state clearing further up
  // the script needs the answer too and used to run before it existed. This block reads that
  // answer instead of re-deriving it, so an extracted block needs the decision the same way it
  // already needs _ROSTER_CLEARED — taken from the SOURCE, never restated here, or this test
  // would pass against a decision the script no longer makes.
  const dStart = src.indexOf('_IS_RESUMED_RUN=0');
  expect(dStart, 'the hoisted resume decision moved — this test is anchored on it').toBeGreaterThan(-1);
  const decision = src.slice(dStart, src.indexOf('\nfi', dStart) + 3);

  const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(join(dir, 'logs'))}
mkdir -p "$LOG_DIR"
_PROJECT_CFG_DIR=${JSON.stringify(cfg)}
${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n')}
${decision}
info() { printf '%s\\n' "$*"; }
warning() { printf '%s\\n' "$*"; }
# Counters the script initialises above the extracted block — an extracted block needs what the
# script provides around it.
_ROSTER_CLEARED=0
_ROSTER_LEFT=0
${block}
`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return { cfg, out };
}

describe('THE REGISTRIES SURVIVE WHEN THE MINT IS SKIPPED', () => {
  it('a skipped mint keeps the roles registry', () => {
    const r = resetRegistries({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(existsSync(join(r.cfg, 'project-roles.json')),
      'the run deleted the registry it was about to depend on').toBe(true);
  });

  it('a skipped mint keeps the investigators registry', () => {
    const r = resetRegistries({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(existsSync(join(r.cfg, 'project-investigators.json'))).toBe(true);
  });

  it('it says why it kept them', () => {
    // Silence here reads as "the reset did not run", which is the opposite of the truth.
    expect(resetRegistries({ EPAM_SKIP_AGENT_MINT: '1' }).out).toMatch(/mint|roster|keep/i);
  });

  it('a resume still keeps them, exactly as before', () => {
    const r = resetRegistries({ EPAM_RESUME_RUN: '20260814T000000Z' });
    expect(existsSync(join(r.cfg, 'project-roles.json'))).toBe(true);
  });

  it('a run that WILL mint still clears them — they are rebuilt, not inherited', () => {
    // The reason the deletion exists: a registry naming agents the new roster never minted points
    // consumers at briefless names. That stays true whenever the mint actually runs.
    const r = resetRegistries({});
    expect(existsSync(join(r.cfg, 'project-roles.json')),
      'a fresh mint inherited the previous run registry').toBe(false);
  });
});

describe('THE LAUNCHER DOES NOT RESTORE BASE STATE OVER A MINTED ROSTER', () => {
  it('the canonical restore is skipped when the mint is skipped', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    const at = src.indexOf('PROFILES_ORIG=');
    expect(at, 'the profiles restore moved').toBeGreaterThan(-1);
    const block = src.slice(at - 600, src.indexOf('\nfi', at) + 3);
    expect(block, 'the launcher still overwrites the roster with base state when the mint is skipped')
      .toMatch(/EPAM_SKIP_AGENT_MINT/);
  });

  it('a run that WILL mint still restores base state', () => {
    // Agent mutations must not carry forward into a run that is about to mint afresh.
    const src = readFileSync(LAUNCHER, 'utf8');
    const at = src.indexOf('PROFILES_ORIG=');
    const block = src.slice(at - 600, src.indexOf('\nfi', at) + 3);
    expect(block).toMatch(/cp "\$PROFILES_ORIG"/);
  });
});
