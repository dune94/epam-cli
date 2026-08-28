/**
 * EVERY AGENT CLIMBS A LADDER — NOT ONLY THE STORY WRITER.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * The InferenceLadder lives in the story path: it reads STORY_MODEL, consults the tier's chain and
 * re-invokes. Gate agents — the failure analyst, the reviewer, the coverage check, the spec
 * validator — are invoked with ORCH_GATE_MODEL, one fixed pair for the whole run. They have no
 * rung, no attempt count, and nothing to escalate.
 *
 * The cost showed on 2026-08-14. Self-heal declared HealingBroken — "same violation repeated
 * without resolution", meaning its own remedy had been applied twice and had not worked — and the
 * only actor that could diagnose WHY runs at a fixed model that never escalates. The system
 * correctly identified that its remedy was broken and had nowhere to go.
 *
 * THE RULE: an agent that can fail can climb. Which ladder it climbs is DECLARED on its archetype
 * (invocation-profiles.json already carries `ladder` per archetype); the chain comes from the
 * settings file. Neither model names nor tier names appear in the engine.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/agent-ladder.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Registry with two archetypes declaring different tiers, and a ladder chain per tier. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ladder-')); dirs.push(dir);
  const registry = join(dir, 'invocation-profiles.json');
  writeFileSync(registry, JSON.stringify({
    profiles: {
      'base-analyst': { _what: 'diagnoses', ladder: 'HIGHEST', produces: 'diagnosis', consumes: [] },
      'base-checker': { _what: 'checks', ladder: 'MEDIUM', produces: 'verdict', consumes: [] },
    },
    seamPatterns: [{ match: '-analyst$', seam: 'base-analyst' }, { match: '-check$', seam: 'base-checker' }],
    defaultSeam: 'base-checker',
  }, null, 2));
  return { dir, registry, logDir: join(dir, 'logs') };
}

/** Ask the REAL library which model an agent should use for its next attempt. */
function climb(agent: string, story: string, opts: {
  fx: ReturnType<typeof fixture>; current: string; escalate?: boolean; order?: string;
  highest?: string; medium?: string;
}): string {
  mkdirSync(opts.fx.logDir, { recursive: true });
  const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(opts.fx.logDir)}
AGENT_PROFILES_REGISTRY=${JSON.stringify(opts.fx.registry)}
NODE_BIN=${JSON.stringify(process.execPath)}
SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
EPAM_MODEL_LADDER_TIER_ORDER=${JSON.stringify(opts.order ?? 'medium high highest')}
EPAM_MODEL_LADDER_HIGHEST=${JSON.stringify(opts.highest ?? 'm-1=m-2|m-2=m-3')}
EPAM_MODEL_LADDER_MEDIUM=${JSON.stringify(opts.medium ?? 'm-1=m-2')}
export LOG_DIR AGENT_PROFILES_REGISTRY NODE_BIN SCRIPT_DIR EPAM_MODEL_LADDER_TIER_ORDER EPAM_MODEL_LADDER_HIGHEST EPAM_MODEL_LADDER_MEDIUM
log() { :; }; warning() { :; }; error() { :; }
. ${JSON.stringify(LIB)}
${opts.escalate ? `agent_ladder_record_failure ${JSON.stringify(agent)} ${JSON.stringify(story)}` : ''}
agent_ladder_model ${JSON.stringify(agent)} ${JSON.stringify(story)} ${JSON.stringify(opts.current)}`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

describe('AN AGENT USES ITS CONFIGURED MODEL UNTIL IT FAILS', () => {
  it('the first attempt uses the model it was given', () => {
    const fx = fixture();
    expect(climb('impl-failure-analyst', 'S-1', { fx, current: 'm-1' })).toBe('m-1');
  });

  it('an agent with no recorded failure never escalates', () => {
    const fx = fixture();
    expect(climb('coverage-check', 'S-1', { fx, current: 'm-1' })).toBe('m-1');
  });
});

describe('A FAILURE MOVES IT UP ITS OWN ARCHETYPE\'S LADDER', () => {
  it('one recorded failure steps one rung', () => {
    // THE 2026-08-14 CASE: self-heal declared HealingBroken and had no stronger analyst to reach.
    const fx = fixture();
    expect(climb('impl-failure-analyst', 'S-1', { fx, current: 'm-1', escalate: true })).toBe('m-2');
  });

  it('the ladder is the one the ARCHETYPE declares, not a single shared one', () => {
    // base-checker declares MEDIUM, whose chain stops at m-2; base-analyst declares HIGHEST.
    const fx = fixture();
    expect(climb('coverage-check', 'S-1', { fx, current: 'm-2', escalate: true }),
      'a MEDIUM-tier agent climbed past the end of its own ladder').toBe('m-2');
    expect(climb('impl-failure-analyst', 'S-2', { fx, current: 'm-2', escalate: true })).toBe('m-3');
  });

  it('state is per AGENT and per STORY — one failure does not escalate everything', () => {
    const fx = fixture();
    climb('impl-failure-analyst', 'S-1', { fx, current: 'm-1', escalate: true });
    expect(climb('impl-failure-analyst', 'S-2', { fx, current: 'm-1' }),
      'another story inherited this story failure').toBe('m-1');
    expect(climb('other-analyst', 'S-1', { fx, current: 'm-1' }),
      'another agent inherited this agent failure').toBe('m-1');
  });

  it('at the top of its ladder it stays there rather than silently no-opping', () => {
    const fx = fixture();
    climb('impl-failure-analyst', 'S-3', { fx, current: 'm-3', escalate: true });
    expect(climb('impl-failure-analyst', 'S-3', { fx, current: 'm-3' })).toBe('m-3');
  });
});

describe('THE ENGINE HOLDS NO MODEL OR TIER VOCABULARY', () => {
  it('the library names no model and no tier', () => {
    const src = readFileSync(LIB, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const t of ['highest', 'medium', 'minimax', 'glm', 'kimi', 'gpt-']) {
      expect(src.toLowerCase(), `agent-ladder.sh hardcodes '${t}'`).not.toContain(t);
    }
  });

  it('an archetype that declares no ladder simply does not climb', () => {
    // Absent is absent: no declaration means no escalation, never a guessed default.
    const fx = fixture();
    const reg = JSON.parse(readFileSync(fx.registry, 'utf8'));
    delete reg.profiles['base-analyst'].ladder;
    writeFileSync(fx.registry, JSON.stringify(reg, null, 2));
    expect(climb('impl-failure-analyst', 'S-9', { fx, current: 'm-1', escalate: true })).toBe('m-1');
  });
});

describe('THE STATE DIES WITH THE RUN', () => {
  it('rung state lives under LOG_DIR, which the pre-run reset clears', () => {
    // A rung that outlives its run escalates a fresh attempt for a previous run's failure — the
    // defect already recorded for the story retry counters.
    const fx = fixture();
    climb('impl-failure-analyst', 'S-1', { fx, current: 'm-1', escalate: true });
    const found = execFileSync('bash', ['-c',
      `find ${JSON.stringify(fx.logDir)} -type f | head -5`], { encoding: 'utf8' }).trim();
    expect(found, 'nothing was persisted under LOG_DIR').not.toBe('');
    expect(found, 'state was written outside LOG_DIR, where the reset cannot reach it')
      .toContain(fx.logDir);
  });
});

describe('THE ANALYST IS WIRED TO THE SEAM — THE FIRST CONSUMER', () => {
  // The seam existing is not the same as an agent using it. This asserts the analyst's retry
  // ACTUALLY climbs, by executing the real block from claude.sh.
  const CLAUDE = join(ROOT, 'orchestrations/scripts/claude.sh');

  it('the analyst records a failure and escalates instead of re-asking the same model', () => {
    const src = readFileSync(CLAUDE, 'utf8');
    // The seam name is declared ONCE (_ANALYST_SEAM) and passed as a variable, so matching a
    // literal here would break the moment that indirection was introduced — and the literal it
    // matched, "failure-analyst", is a name the profiles registry does not contain, so the call
    // it was guarding resolved no tier and never escalated. Match the CALL, not a spelling.
    const at = src.search(/agent_ladder_record_failure\s+"\$?_?[A-Za-z_]/);
    expect(at, 'the analyst retry does not touch the ladder seam').toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('if [ -z "$(printf', at));

    const fx = fixture();
    mkdirSync(fx.logDir, { recursive: true });
    const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(fx.logDir)}
AGENT_PROFILES_REGISTRY=${JSON.stringify(fx.registry)}
NODE_BIN=${JSON.stringify(process.execPath)}
SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
EPAM_MODEL_LADDER_TIER_ORDER="medium high highest"
EPAM_MODEL_LADDER_HIGHEST="m-1=m-2|m-2=m-3"
export LOG_DIR AGENT_PROFILES_REGISTRY NODE_BIN SCRIPT_DIR EPAM_MODEL_LADDER_TIER_ORDER EPAM_MODEL_LADDER_HIGHEST
story_id=S-ANALYST
gate_model=m-1
# The seam this block escalates. run_failure_analyst declares it once in its own scope, so an
# extracted snippet has to be given it — and it must be the name the REGISTRY actually contains,
# since agent_ladder_model resolves the tier through it. A name the registry lacks resolves no
# tier, returns the model unchanged, and this assertion would fail for the right reason.
_ANALYST_SEAM=impl-failure-analyst
warning() { printf 'WARN %s\\n' "$*"; }
. ${JSON.stringify(LIB)}
${block.replace(/^\s*local /gm, '')}
printf 'MODEL=%s\\n' "$gate_model"`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(out, 'the analyst did not escalate after an unusable answer').toContain('MODEL=m-2');
    expect(out, 'the escalation was silent').toMatch(/escalating the ANALYST/);
  });

  it('the analyst climbs the ladder ITS archetype declares', () => {
    // impl-failure-analyst declares HIGHEST in the shipped registry — it must not inherit the
    // writer's tier, nor a single shared one.
    const reg = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    expect(reg.profiles['impl-failure-analyst'].ladder,
      'the analyst archetype declares no ladder, so it cannot climb').toBeTruthy();
  });
});
