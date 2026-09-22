/**
 * THE REVIEWER'S OWN LADDER RESUME MUST CARRY THE PROVIDER WITH THE MODEL.
 *
 * team-lead-review.sh keeps a review-scoped rung across review cycles: on resume it walks
 * _base_model up the chain. It walked the MODEL only — the provider stayed the WRITER's
 * (`_model="$_base_model"; _provider="$_base_provider"`), so a resumed rung served by another
 * vendor was announced to the gateway as the writer's vendor. Live 2026-09-22 that pair reached
 * the vendor as 400 "unknown model" and the review came back empty three times.
 *
 * Same rule as lib/model-ladder.sh's sync_provider_to_model, and the same rule the gateway now
 * enforces in llm-handler.sh: a rung is a model AND a provider. The caller must not hand the
 * gateway a pair its own declaration contradicts.
 *
 * Executes the REAL run_review_prompt with the agent invocation stubbed, so the assertion is on
 * the pair the invocation ACTUALLY received.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
const TLR = join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh');
const PROVIDER_MAP_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/provider-map.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runReviewPrompt(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tlr-resume-provider-'));
  dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const seen = join(dir, 'seen.txt');
  writeFileSync(seen, '');

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export LOG_DIR=${JSON.stringify(logDir)}`,
    'export PROJECT_ROOT="$LOG_DIR"',
    'export AI_RUNNER_CMD=/bin/echo',
    // the project's declaration: the writer's rung is one vendor's, the rung above is another's
    "export EPAM_MODEL_PROVIDER_MAP='fixture-small-*=minimax|fixture-big-*=openrouter'",
    'log() { :; }; warning() { :; }; error() { :; }; success() { :; }',
    // the reviewer resumed one rung from an earlier cycle
    'ai_ladder_state_key() { echo "review-agent.$2"; }',
    'read_story_retry_count() { echo 1; }',
    'advance_ladder_escalation() { echo 1; }',
    '_ladder_next_model() { case "$1" in fixture-small-1) echo fixture-big-1 ;; *) echo "" ;; esac; }',
    '_ladder_skip_reason() { echo ""; }',
    // the receiver: record the pair it was actually given, then answer with a verdict
    `invoke_agent() { local m="" p="" prev=""; for a in "$@"; do case "$prev" in --model) m="$a";; --provider) p="$a";; esac; prev="$a"; done; echo "$p|$m" >> ${JSON.stringify(seen)}; echo '{"verdict":"approved"}'; }`,
    `. ${JSON.stringify(PROVIDER_MAP_LIB)}`,
    shellFunction(TLR, '_provider_for_model'),
    shellFunction(TLR, 'run_review_prompt'),
    'story_id=S-1 PHASE_ID=core',
    // the WRITER's pair: the small model on its own vendor
    'run_review_prompt "review this" "fixture-small-1" "minimax" >/dev/null',
  ].join('\n'));

  spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  return readFileSync(seen, 'utf8').trim();
}

describe("the reviewer's resumed rung keeps its provider", () => {
  it('invokes the resumed model on the provider the project declares for it, not the writer\'s', () => {
    const pair = runReviewPrompt();
    expect(pair, 'the reviewer never invoked the agent at all').not.toBe('');
    expect(pair, 'the resumed rung was announced with the writer\'s vendor — the live 400')
      .toBe('openrouter|fixture-big-1');
  });
});
