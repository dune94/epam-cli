/**
 * THE LADDER'S JOB IS WHICH MODEL RUNS. NOTHING ASSERTED THAT.
 *
 * Ten test files touch story-retry-state; eight execute get_model_ladder_step; one is named
 * ladder-resumes-across-invocations.test.ts. Every assertion in that file is on the COUNTER
 * (`seedRetryCount(...) === 4`). `grep STORY_MODEL test/` returns nothing. The counter is a
 * proxy; the model is the outcome, and the outcome was never checked.
 *
 * What the code does:
 *   - lib/story-retry-state.sh persists ONE integer: ${story_id}.count
 *   - claude.sh:1028 re-derives STORY_MODEL from the PRD's .model on every invocation
 *   - a Step 3.6 review rejection or a watchdog retry re-invokes claude.sh as a NEW process
 *
 * So retry_count survives and STORY_MODEL does not. A story re-entering at rung 2 resets to the
 * PRD model and takes ONE ladder step from there — it does not resume where it escalated to.
 * Live 2026-08-10: `InferenceLadder[Rung3/R8]: model 'MiniMax-M3' -> 'z-ai/glm-5.2'` — the
 * rung-1 model, at rung 3, burning rung 3's retry budget and its largest iteration allowance.
 *
 * This test asserts the CONSEQUENCE: after a re-invocation at rung 2, which model does the
 * story actually run? Not "is the count 4", not "is STORY_MODEL in the state file" — those are
 * mechanisms and both can be satisfied while the story still runs the wrong model.
 *
 * Chains are read from the project's real llm-settings.json. Nothing here hardcodes a model
 * name as an expectation: the expected model is derived by walking the configured chain the
 * number of steps the rung implies, so the test stays correct when the ladder is reconfigured.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// LADDERS AND MODEL OVERRIDES MOVED TO THE STACK. The 2026-08-25 migration took them out of each
// project's llm-settings.json and into config/llm-defaults.<set>.json — a ladder names MODELS and
// a model belongs to a STACK. This file read the project copy, which now carries only a note
// saying so, so every lookup came back empty. See test/support/llm-settings.ts.
import { stackSettings, defaultStack } from '../../support/llm-settings'
const REPO_ROOT_CFG = join(__dirname, '../../../orchestrations/config');

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const SETTINGS = join(REPO_ROOT_CFG, `llm-defaults.${defaultStack()}.json`);
const SRC = readFileSync(CLAUDE_SH, 'utf8');
const CFG = JSON.parse(readFileSync(SETTINGS, 'utf8'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  expect(m, `no definition for ${name}()`).toBeTruthy();
  const i = (m as RegExpExecArray).index;
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
}

const START_MODEL = 'MiniMax-M3';

/** claude.sh's real persisted-model seed, executed rather than restated. */
function seedBlock(): string {
  const i = SRC.indexOf('local _persisted_model');
  expect(i, 'the persisted-model seed is missing from claude.sh').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n    fi\n', i) + '\n    fi\n'.length;
  return SRC.slice(i, end).replace(/^\s*local /gm, '');
}

/** claude.sh's real persist call — what a prior process runs to leave the model behind. */
function persistCall(): string {
  const m = /write_story_retry_model "\$LOG_DIR" "\$story_id" "\$\{STORY_MODEL:-\}"/.exec(SRC);
  expect(m, 'claude.sh never persists the model — the ladder cannot resume its climb').toBeTruthy();
  return (m as RegExpExecArray)[0].replace('$story_id', 'S-1');
}

/** Walks the configured chain n steps — the model the ladder SHOULD be on at rung n. */
function expectedModelAtRung(tier: string, rung: number): string {
  const edges = new Map<string, string>(
    (CFG.ladders[tier]?.modelLadder ?? []).map((e: { from: string; to: string }) => [e.from, e.to]));
  let m = START_MODEL;
  for (let i = 0; i < rung; i++) {
    const next = edges.get(m);
    if (!next || next === m) break;   // chain terminates: staying put is correct
    m = next;
  }
  return m;
}

function ladderEnv(): string {
  const ser = (t: string) => (CFG.ladders[t]?.modelLadder ?? [])
    .map((e: { from: string; to: string }) => `${e.from}=${e.to}`).join('|');
  return [
    `export EPAM_MODEL_LADDER_HIGH=${JSON.stringify(ser('high'))}`,
    `export EPAM_MODEL_LADDER_MEDIUM=${JSON.stringify(ser('medium'))}`,
    `export EPAM_MODEL_LADDER_HIGHEST=${JSON.stringify(ser('highest'))}`,
  ].join('\n');
}

/** A run directory with a PRD pinning the tier, plus the persisted retry state. */
function fixture(tier: string, persistedRetryCount: number, persistModel = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ladderbehav-')); dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(join(logDir, 'story-retry-state'), { recursive: true });
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'S-1', title: 't', model: START_MODEL, ladderTier: tier }],
  }));
  // What a prior claude.sh process leaves behind. The count was always written; the model is
  // the half that was missing, and `persistModel: false` reproduces the pre-fix state exactly.
  writeFileSync(join(logDir, 'story-retry-state', 'S-1.count'), String(persistedRetryCount));
  if (persistModel) {
    // Runs claude.sh's OWN persist call. Deleting it from claude.sh makes this write nothing,
    // so the resume has no state and the test fails — which is what a mutation must do.
    execFileSync('bash', ['-c',
      `set -u\nLOG_DIR=${JSON.stringify(logDir)}\n` +
      `STORY_MODEL=${JSON.stringify(expectedModelAtRung(tier, Math.floor(persistedRetryCount / 2)))}\n` +
      `${readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh'), 'utf8')}\n` +
      `${persistCall()}`], { encoding: 'utf8' });
  }
  return { dir, logDir, prd };
}

/**
 * Simulates a FRESH claude.sh process re-entering a story that already climbed.
 *
 * Reproduces the real sequence with the real functions: seed retry_count from the state file
 * (claude.sh:8196), re-derive STORY_MODEL from the PRD (claude.sh:1028), classify the tier, and
 * take the ladder step the rung transition performs. Returns the model the attempt would run.
 */
function modelAfterReinvocation(f: ReturnType<typeof fixture>): string {
  const SEED_BLOCK = seedBlock();
  const script = join(f.dir, 'reinvoke.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -u
log() { :; }; warning() { :; }; error() { :; }; info() { :; }; success() { :; }
${ladderEnv()}
LOG_DIR=${JSON.stringify(f.logDir)}
PRD_FILE=${JSON.stringify(f.prd)}
MAIN_PRD_FILE=${JSON.stringify(f.prd)}
${readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh'), 'utf8')}
${lift('get_model_ladder_step')}
${lift('classify_ladder_tier')}
${lift('resolve_model_provider')}

# --- a new claude.sh process starts here ---
story_id=S-1
STORY_PROVIDER=""
retry_count="$(read_story_retry_count "$LOG_DIR" S-1)"          # persists  (claude.sh:8196)
STORY_MODEL="$(jq -r '.stories[0].model' "$PRD_FILE")"          # re-derived (claude.sh:1028)
tier="$(classify_ladder_tier S-1)"
rung=$(( retry_count / 2 ))
# THE REAL SEED BLOCK, lifted verbatim from claude.sh. Re-implementing it here would make this
# test green while the pipeline stayed broken — verified: with a hand-written equivalent, BOTH
# mutations (removing the persist, removing the resume) survived.
${SEED_BLOCK}
if [ -z "$(read_story_retry_model "$LOG_DIR" S-1)" ] && [ "$rung" -gt 0 ]; then
  step="$(get_model_ladder_step "$STORY_MODEL" "$tier")"
  [ -n "$step" ] && STORY_MODEL="$step"
fi
printf '%s' "$STORY_MODEL"
`);
  return execFileSync('bash', [script], { encoding: 'utf8' }).trim();
}

describe('the fixture is real — the state file holds what the pipeline actually writes', () => {
  it('a prior process leaves only a count behind', () => {
    const f = fixture('high', 4);
    const state = readFileSync(join(f.logDir, 'story-retry-state', 'S-1.count'), 'utf8').trim();
    expect(state).toBe('4');
  });

  it('the retry count really does survive into the new process', () => {
    const f = fixture('high', 4);
    const out = execFileSync('bash', ['-c',
      `${readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh'), 'utf8')}
       read_story_retry_count ${JSON.stringify(f.logDir)} S-1`], { encoding: 'utf8' }).trim();
    expect(out, 'the counter fix works — that half is not in question').toBe('4');
  });
});

describe('THE DEFECT: the model does not resume where the ladder left it', () => {
  // rung 2 = retry_count 4. The chain has been climbed twice by then.
  for (const tier of ['medium', 'high', 'highest']) {
    it(`[${tier}] a story re-entering at rung 2 runs the rung-2 model`, () => {
      const expected = expectedModelAtRung(tier, 2);
      const actual = modelAfterReinvocation(fixture(tier, 4));
      expect(
        actual,
        `[${tier}] rung 2 should run ${expected}; STORY_MODEL reset to ${START_MODEL} and took ` +
        `a single step instead. The story burns rung 2's retry budget on a lower rung's model.`,
      ).toBe(expected);
    });
  }

  it('[high] at rung 3 the story is still not at the top of its chain', () => {
    const expected = expectedModelAtRung('high', 3);
    expect(modelAfterReinvocation(fixture('high', 6))).toBe(expected);
  });

  it('rung 1 is unaffected — one step from the start IS correct there', () => {
    // Proves the defect is specifically about ACCUMULATED climb, not about stepping at all.
    const expected = expectedModelAtRung('high', 1);
    expect(modelAfterReinvocation(fixture('high', 2))).toBe(expected);
  });

  it('without the persisted model the old defect reproduces — the fixture is not rigged', () => {
    // persistModel:false is exactly the pre-2026-08-10 state file: a count and nothing else.
    const actual = modelAfterReinvocation(fixture('high', 4, false));
    expect(actual, 'this is what the ladder did before the model was persisted').toBe('z-ai/glm-5.2');
    expect(actual).not.toBe(expectedModelAtRung('high', 2));
  });

  it('rung 0 stays on the PRD model', () => {
    expect(modelAfterReinvocation(fixture('high', 0))).toBe(expectedModelAtRung('high', 0));
  });
});

describe('the state the fix must persist', () => {
  it('story-retry-state.sh persists the model, not only the count', () => {
    const lib = readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh'), 'utf8');
    expect(
      lib,
      'only the counter survives a re-invocation, so the ladder restarts its climb every time',
    ).toMatch(/model/i);
  });
});
