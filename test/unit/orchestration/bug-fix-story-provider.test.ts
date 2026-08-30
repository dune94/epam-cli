/**
 * Regression guard: auto-generated BUG-* stories (Step 4.5's bug-fix flow)
 * must never assign aiProvider="openrouter" — that string is not a
 * recognized provider anywhere in this codebase. provider_to_cli() in
 * claude.sh only accepts opencode|codex|copilot|openai|openrouter|cursor|minimax|
 * codemie-claude; "openrouter" hits its error branch and the story fails
 * immediately. The correct provider name for routing to OpenRouter models
 * (including anthropic/* slugs like the sonnet escalation) is "openrouter".
 *
 * Spotted during review, not yet triggered live — this test prevents it
 * from ever regressing back in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');

const orchSrc = readFileSync(ORCH_SH, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('provider_to_cli — confirms "openrouter" is not a recognized provider', () => {
  it('the valid provider list does not include "openrouter"', () => {
    const idx = claudeSrc.indexOf('provider_to_cli()');
    const fnEnd = claudeSrc.indexOf('\n}', idx);
    const body = claudeSrc.slice(idx, fnEnd);
    expect(body).not.toMatch(/openrouter\)/);
  });

  it('openrouter IS a recognized provider (the correct OpenRouter-routing name)', () => {
    const idx = claudeSrc.indexOf('provider_to_cli()');
    const fnEnd = claudeSrc.indexOf('\n}', idx);
    const body = claudeSrc.slice(idx, fnEnd);
    expect(body).toMatch(/openrouter/);
  });
});

describe('run-agent-orchestration.sh — bug-fix story creation never uses "openrouter" as a provider', () => {
  it('the script contains no bare "openrouter" provider assignment anywhere', () => {
    // Comments mentioning OpenRouter as a concept are fine; only a literal
    // provider-value assignment ("openrouter") would break provider_to_cli.
    expect(orchSrc).not.toMatch(/"openrouter"/);
  });

  it('the owner-story aiProvider has NO engine-chosen default at all', () => {
    // WAS: expected `.aiProvider // "openrouter"`. The concern behind it was real — "openrouter" is not
    // a provider name this pipeline uses — but the fix named a DIFFERENT provider in the engine,
    // which is the same defect one value over. A project declares its providers; the engine picks
    // none. The provider now follows the model through EPAM_MODEL_PROVIDER_MAP.
    expect(orchSrc, 'the engine still chooses a provider on the project’s behalf')
      .not.toMatch(/\.aiProvider \/\/ "[a-z]/);
    expect(orchSrc, 'the aiProvider read is gone entirely').toMatch(/\.aiProvider \/\/ empty/);
  });

  it('round 2 escalation climbs the writer’s own ladder, not a shared escalation pin', () => {
    // The original requirement stands: no third model path smuggled in here.
    expect(orchSrc).not.toMatch(/anthropic\/claude-sonnet/);

    // What changed: ESCALATION_MODEL was ONE run-wide model every agent escalated to regardless
    // of where it started — a second pin, not a ladder. Round 2 now walks one rung of the
    // writer's own chain, and names no provider, because the provider follows the model.
    const idx = orchSrc.indexOf('model_override=$(seam_next_model');
    expect(idx, 'round 2 no longer climbs the ladder').toBeGreaterThan(-1);
    const block = orchSrc.slice(idx, idx + 200);
    expect(block, 'a provider is still named here').toMatch(/provider_override=""/);
  });

  it('the escalation target is not a model name written into the engine', () => {
    // WAS: asserted the fallback literal WAS z-ai/glm-5.2 — a test whose only job was to keep a
    // vendor model name pinned in the engine. Matching "the InferenceLadder default" is now
    // structural rather than textual: both ask the same ladder, so they cannot disagree.
    const idx = orchSrc.indexOf('model_override=');
    expect(idx).toBeGreaterThan(-1);
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    expect(line, 'a vendor model name is back in the escalation path')
      .not.toMatch(/MiniMax-M|z-ai\/glm|moonshotai\/kimi/);
  });

  it('REGRESSION: bug-fix story\'s failing-file path uses $PROJECT_ROOT, not a hardcoded /tmp/skyscanner-app prefix (would point at a nonexistent path for the real project outputDir)', () => {
    expect(orchSrc).not.toMatch(/--arg ffile "\/tmp\/skyscanner-app/);
    const idx = orchSrc.indexOf('--arg ffile "');
    expect(idx).toBeGreaterThan(-1);
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    expect(line).toMatch(/\$\{PROJECT_ROOT\}/);
  });
});
