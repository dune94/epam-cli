/**
 * Changing the MODEL without re-resolving the PROVIDER sends a model to a
 * vendor that has never heard of it.
 *
 * Live AMSD-2041 2026-07-30. All three lanes died within a minute of each
 * other, every attempt sub-second with zero tokens and $0 cost. The captured
 * stderr:
 *
 *   Error: All providers exhausted without a successful response.
 *   Attempted: minimax/z-ai/glm-5.1: MiniMax API error: 400
 *     invalid params, unknown model 'z-ai/glm-5.1' (2013)
 *
 * `z-ai/glm-5.1` is an OpenRouter model. It was sent to MiniMax, which
 * rejected it at the door — before any inference, which is why it cost
 * nothing and took no time.
 *
 * The pairing was built by resolve_model_from_story. STORY_PROVIDER comes from
 * the story's aiProvider (written by the coordinator alongside the CHEAP model
 * CPA sized). The novel-brownfield override then replaces STORY_MODEL with the
 * project's high-tier model — and left STORY_PROVIDER pointing at the vendor
 * that hosted the model it just discarded.
 *
 * Every ladder site already does this correctly:
 *
 *   STORY_MODEL="$escalated_model_r2"
 *   _resolved_provider_r2=$(resolve_model_provider "$escalated_model_r2")
 *   [ -n "$_resolved_provider_r2" ] && STORY_PROVIDER="$_resolved_provider_r2"
 *
 * The override was written without that half.
 *
 * THE RULE: model and provider are one decision, not two. Any code that
 * reassigns STORY_MODEL must re-resolve STORY_PROVIDER through
 * EPAM_MODEL_PROVIDER_MAP, or it can produce a pairing no provider can serve.
 *
 * Note what the ladder could not do here: a 400 "unknown model" is permanent,
 * but the coordinator diagnosed it as "binary and key are healthy —
 * model/timeout issue" and escalated. Climbing rungs re-sent the same
 * impossible pairing eight times per lane.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in claude.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/**
 * Run the REAL resolver against a real PRD and report the model/provider pair
 * it actually produces. Both functions are extracted from claude.sh — a change
 * that fixes only the test's copy cannot pass this.
 */
function resolve(story: Record<string, unknown>, env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'route-'));
  dirs.push(d);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [story] }));

  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PRD_FILE=${JSON.stringify(prd)}
MAIN_PRD_FILE=${JSON.stringify(prd)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('resolve_model_provider')}
${fnText('resolve_provider_settings')}
${fnText('provider_to_cli')}
${fnText('resolve_model_from_story')}
# Production order: the provider is resolved from the story FIRST, then the
# model override runs (claude.sh:6446 then :6465).
resolve_provider_settings ${JSON.stringify(story.id)}
resolve_model_from_story ${JSON.stringify(story.id)}
echo "MODEL=\${STORY_MODEL:-}"
echo "PROVIDER=\${STORY_PROVIDER:-}"
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    model: (out.match(/MODEL=(.*)/) || [, ''])[1].trim(),
    provider: (out.match(/PROVIDER=(.*)/) || [, ''])[1].trim(),
    out,
  };
}

// The live configuration, verbatim from projects/metrolinx/config.env.
const MAP = 'zhipuai/*=openrouter|moonshotai/*=openrouter|z-ai/*=openrouter|glm-*=openrouter|kimi-*=openrouter|deepseek/*=openrouter|MiniMax-*=minimax';
const BROWNFIELD_NOVEL = { EPAM_BROWNFIELD: '1', ESCALATION_MODEL_HIGH: 'z-ai/glm-5.1', EPAM_MODEL_PROVIDER_MAP: MAP };

/** The live story: CPA sized it cheap, so the coordinator paired MiniMax with a MiniMax model. */
const STORY = { id: 'AMSD-2041', model: 'MiniMax-M3', aiProvider: 'minimax', storyKind: 'novel' };

describe('the novel-brownfield override re-routes the provider with the model', () => {
  it('does not leave an OpenRouter model pointed at MiniMax', () => {
    const { model, provider } = resolve(STORY, BROWNFIELD_NOVEL);
    expect(model, 'the override did not fire — this test is asserting nothing').toBe('z-ai/glm-5.1');
    expect(provider,
      `model '${model}' was sent to provider '${provider}'. MiniMax rejects it with ` +
      '400 "unknown model" before any inference: sub-second, zero tokens, $0, ' +
      'and eight retries up a ladder that cannot fix a wrong vendor.')
      .toBe('openrouter');
  });

  it('leaves the provider alone when the override does not fire', () => {
    // A defect story keeps CPA's model, so its provider must stay untouched —
    // the fix must not re-route every story through the map.
    const { model, provider } = resolve({ ...STORY, storyKind: 'defect' }, BROWNFIELD_NOVEL);
    expect(model).toBe('MiniMax-M3');
    expect(provider, 'a story that kept its model had its provider changed').toBe('minimax');
  });

  it('leaves the provider alone outside brownfield', () => {
    const { provider } = resolve(STORY, { ...BROWNFIELD_NOVEL, EPAM_BROWNFIELD: '0' });
    expect(provider).toBe('minimax');
  });

  it('keeps the story provider when the map has no entry for the new model', () => {
    // resolve_model_provider returns empty on no match, and its documented
    // contract is that the caller keeps STORY_PROVIDER unchanged. Blanking the
    // provider would break every project that configures no map at all.
    const { model, provider } = resolve(STORY, { ...BROWNFIELD_NOVEL, EPAM_MODEL_PROVIDER_MAP: 'nothing/*=openrouter' });
    expect(model).toBe('z-ai/glm-5.1');
    expect(provider, 'an unmatched model blanked the provider instead of keeping it').toBe('minimax');
  });

  it('survives no map being configured at all', () => {
    const { provider } = resolve(STORY, { ...BROWNFIELD_NOVEL, EPAM_MODEL_PROVIDER_MAP: '' });
    expect(provider).toBe('minimax');
  });
});

describe('the pairing rule holds wherever the model is reassigned', () => {
  it('every STORY_MODEL assignment is followed by a provider re-resolution', () => {
    // The ladder sites already did this; the override did not, and nothing
    // flagged the omission. Assignments from a LITERAL (a fixed default, or
    // reading the story's own paired model) are exempt — the defect is
    // specifically swapping in a model chosen independently of the provider.
    const lines = SRC.split('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      const m = line.match(/^\s*STORY_MODEL="\$([A-Za-z_][A-Za-z0-9_]*)"/);
      if (!m) return;
      const varName = m[1];
      // The paired read from the PRD — model and aiProvider come from the same
      // story record, so they are consistent by construction.
      if (varName === 'story_model') return;
      // The effort-tier defaults, assigned in resolve_effort_settings BEFORE
      // resolve_provider_settings runs (claude.sh:6430 then :6446). Anything they
      // set would be clobbered, so the pairing is made afterwards, in
      // resolve_model_from_story's effort-default branch — which this sweep
      // checks on its own line.
      if (/^EFFORT_MODEL_/.test(varName)) return;
      // The configured final fallback: EPAM_FINAL_FALLBACK_MODEL is paired with
      // EPAM_FINAL_FALLBACK_PROVIDER in the same config, applied on the next line.
      if (varName === '_ffm') return;
      // Long rationale comments sit between the assignment and the call.
      const window = lines.slice(i, i + 24).join('\n');
      if (!/resolve_model_provider/.test(window)) {
        offenders.push(`claude.sh:${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders,
      'STORY_MODEL is reassigned without re-resolving STORY_PROVIDER — the exact ' +
      'shape that sent z-ai/glm-5.1 to MiniMax:\n' + offenders.join('\n'))
      .toEqual([]);
  });
});
