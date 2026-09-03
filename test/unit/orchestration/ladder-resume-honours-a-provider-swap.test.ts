// A PERSISTED LADDER RUNG FROM A DIFFERENT PROVIDER SET IS NOT A RUNG TO RESUME.
//
// Operator, 2026-09-03, on why hot-swap matters: "people run out of tokens - so they have to
// swap to another set of providers potentially." That is a MID-RUN action: the operator swaps
// EPAM_PROVIDER_SET and re-launches, and claude.sh's resume logic (implement_story) picks the
// story back up from wherever the ladder had escalated to in the PREVIOUS invocation.
//
// Before this fix, the persisted rung was a MODEL NAME ONLY ("MiniMax-M3"), with no record of
// which provider set chose it. resolve_model_provider() correctly re-derives the PROVIDER fresh
// from the CURRENT EPAM_MODEL_PROVIDER_MAP on every invocation — so after a swap it would
// (correctly) fail to route "MiniMax-M3" under a set with no MiniMax entries and leave
// STORY_PROVIDER alone. But STORY_MODEL was set from the persisted name UNCONDITIONALLY, so the
// resumed invocation would pair a correctly-resolved NEW provider with a STALE model name from
// the OLD vendor's namespace — the exact "model and provider are one decision" defect this file
// already fixed once (2026-08-18, AMSD-2041, z-ai/glm-5.2 sent to minimax), reintroduced here by
// a swap instead of a missed re-derivation.
//
// These tests EXECUTE the real functions extracted from claude.sh (fnText() — a change that
// fixes only a copy cannot pass this) against real fixtures.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE, 'utf8');
const RETRY_STATE_LIB = join(__dirname, '../../../orchestrations/scripts/lib/story-retry-state.sh');
const RESOLVE_PRIMARY_PROVIDER_LIB =
  join(__dirname, '../../../orchestrations/scripts/lib/resolve-primary-provider.sh');

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in claude.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Runs the REAL resume-decision block extracted from implement_story() — the exact lines that
 * read the persisted rung, decide whether to trust it, and set STORY_MODEL/STORY_PROVIDER —
 * against real persisted state and a real EPAM_PROVIDER_SET.
 */
function resume(opts: {
  storyId: string;
  persistedModel: string;
  persistedSet: string;
  currentSet: string;
  modelProviderMap: string;
}) {
  const d = mkdtempSync(join(tmpdir(), 'resume-'));
  dirs.push(d);
  const logDir = join(d, 'logs');
  mkdirSync(join(logDir, 'story-retry-state'), { recursive: true });
  if (opts.persistedModel) {
    writeFileSync(join(logDir, 'story-retry-state', `${opts.storyId}.model`), opts.persistedModel);
  }
  if (opts.persistedSet) {
    writeFileSync(join(logDir, 'story-retry-state', `${opts.storyId}.provider-set`), opts.persistedSet);
  }

  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
LOG_DIR=${JSON.stringify(logDir)}
log(){ :; }; warning(){ :; }; error(){ :; }
. ${JSON.stringify(RETRY_STATE_LIB)}
. ${JSON.stringify(RESOLVE_PRIMARY_PROVIDER_LIB)}
${fnText('resolve_model_provider')}
story_id=${JSON.stringify(opts.storyId)}

# THE REAL RESUME-DECISION BLOCK, extracted verbatim from implement_story().
_persisted_model="$(read_story_retry_model "$LOG_DIR" "$story_id")"
_persisted_set="$(read_story_retry_provider_set "$LOG_DIR" "$story_id")"
if [ -n "$_persisted_set" ] && [ "$_persisted_set" != "\${EPAM_PROVIDER_SET:-}" ]; then
    _persisted_model=""
fi
if [ -n "$_persisted_model" ] && [ "$_persisted_model" != "\${STORY_MODEL:-}" ]; then
    STORY_MODEL="$_persisted_model"
    STORY_MODEL_LADDER_RESUMED="$_persisted_model"
    _resumed_provider=$(resolve_model_provider "$_persisted_model")
    [ -n "$_resumed_provider" ] && STORY_PROVIDER="$_resumed_provider"
fi
echo "MODEL=\${STORY_MODEL:-}"
echo "PROVIDER=\${STORY_PROVIDER:-}"
echo "RESUMED=\${STORY_MODEL_LADDER_RESUMED:-}"
`);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, EPAM_PROVIDER_SET: opts.currentSet, EPAM_MODEL_PROVIDER_MAP: opts.modelProviderMap },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    model: (out.match(/MODEL=(.*)/) || [, ''])[1].trim(),
    provider: (out.match(/PROVIDER=(.*)/) || [, ''])[1].trim(),
    resumed: (out.match(/RESUMED=(.*)/) || [, ''])[1].trim(),
    out,
  };
}

const OPENROUTER_MAP = 'MiniMax-*=minimax|zhipuai/*=openrouter';

describe('the resume-decision block used above is a real copy of claude.sh, not a fiction', () => {
  // The behavioural tests below hand-copy the resume-decision logic (it lives inline in
  // implement_story(), not its own function, so fnText() cannot extract it). That copy could
  // drift from the real source silently — this asserts the ACTUAL claude.sh still contains the
  // exact guard, so a future edit that removes or weakens it fails HERE even if the copy above
  // was never updated.
  it('claude.sh still discards a mismatched persisted set before trusting the model', () => {
    expect(SRC).toMatch(
      /_persisted_set="\$\(read_story_retry_provider_set "\$LOG_DIR" "\$story_id"\)"\s*\n\s*if \[ -n "\$_persisted_set" \] && \[ "\$_persisted_set" != "\$\{EPAM_PROVIDER_SET:-\}" \]; then\s*\n[^\n]*\n\s*_persisted_model=""/
    );
  });

  it('the write sites persist the set alongside the model, all three of them', () => {
    const count = (SRC.match(/write_story_retry_provider_set "\$LOG_DIR" "\$story_id" "\$\{EPAM_PROVIDER_SET:-\}"/g) || []).length;
    expect(count, 'expected the same 3 write sites as write_story_retry_model has').toBe(3);
  });
});

describe('resume after a provider swap — the actual mid-run scenario', () => {
  it('DISCARDS a persisted rung chosen under a DIFFERENT set — no stale model/provider pairing', () => {
    const r = resume({
      storyId: 'S-1',
      persistedModel: 'MiniMax-M3',
      persistedSet: 'openrouter',
      currentSet: 'claude',
      modelProviderMap: '', // claude set declares no glob map
    });
    expect(r.resumed, `out: ${r.out}`).toBe('');
    expect(r.model, 'a MiniMax-only model name survived a swap to the claude set').toBe('');
    rmSync;
  });

  it('TRUSTS a persisted rung chosen under the SAME set — an ordinary resume, unaffected', () => {
    const r = resume({
      storyId: 'S-1',
      persistedModel: 'MiniMax-M3',
      persistedSet: 'openrouter',
      currentSet: 'openrouter',
      modelProviderMap: OPENROUTER_MAP,
    });
    expect(r.resumed, `out: ${r.out}`).toBe('MiniMax-M3');
    expect(r.model).toBe('MiniMax-M3');
    expect(r.provider).toBe('minimax');
  });

  it('TRUSTS a persisted rung with NO recorded set — predates the marker, nothing to contradict', () => {
    const r = resume({
      storyId: 'S-1',
      persistedModel: 'MiniMax-M3',
      persistedSet: '',
      currentSet: 'openrouter',
      modelProviderMap: OPENROUTER_MAP,
    });
    expect(r.resumed, `out: ${r.out}`).toBe('MiniMax-M3');
  });

  it('a genuinely fresh story (no persisted state at all) is unaffected either way', () => {
    const r = resume({
      storyId: 'S-1',
      persistedModel: '',
      persistedSet: '',
      currentSet: 'claude',
      modelProviderMap: '',
    });
    expect(r.resumed, `out: ${r.out}`).toBe('');
  });
});
