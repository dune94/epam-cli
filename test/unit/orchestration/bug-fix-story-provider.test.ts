/**
 * Regression guard: auto-generated BUG-* stories (Step 4.5's bug-fix flow)
 * must never assign aiProvider="openrouter" — that string is not a
 * recognized provider anywhere in this codebase. provider_to_cli() in
 * claude.sh only accepts opencode|codex|copilot|openai|qwen|cursor|minimax|
 * codemie-claude; "openrouter" hits its error branch and the story fails
 * immediately. The correct provider name for routing to OpenRouter models
 * (including anthropic/* slugs like the sonnet escalation) is "qwen".
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

  it('qwen IS a recognized provider (the correct OpenRouter-routing name)', () => {
    const idx = claudeSrc.indexOf('provider_to_cli()');
    const fnEnd = claudeSrc.indexOf('\n}', idx);
    const body = claudeSrc.slice(idx, fnEnd);
    expect(body).toMatch(/qwen/);
  });
});

describe('run-agent-orchestration.sh — bug-fix story creation never uses "openrouter" as a provider', () => {
  it('the script contains no bare "openrouter" provider assignment anywhere', () => {
    // Comments mentioning OpenRouter as a concept are fine; only a literal
    // provider-value assignment ("openrouter") would break provider_to_cli.
    expect(orchSrc).not.toMatch(/"openrouter"/);
  });

  it('the owner-story aiProvider fallback defaults to "qwen", not "openrouter"', () => {
    expect(orchSrc).toMatch(/\.aiProvider \/\/ "qwen"/);
  });

  it('round 2 bug-fix escalation uses the configured ESCALATION_MODEL, not a hardcoded Anthropic model', () => {
    // A hardcoded anthropic/claude-sonnet model would be a third, inconsistent
    // model path alongside the MiniMax + OpenRouter roster this pipeline uses
    // everywhere else (ANTHROPIC_API_KEY existing globally is not sufficient
    // justification — this tier3 pipeline is deliberately scoped).
    expect(orchSrc).not.toMatch(/anthropic\/claude-sonnet/);
    const idx = orchSrc.indexOf('model_override="${ESCALATION_MODEL');
    expect(idx).toBeGreaterThan(-1);
    const block = orchSrc.slice(idx, idx + 100);
    expect(block).toMatch(/provider_override="qwen"/);
  });

  it('ESCALATION_MODEL fallback default matches the InferenceLadder default (z-ai/glm-5.2)', () => {
    const idx = orchSrc.indexOf('model_override="${ESCALATION_MODEL');
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    expect(line).toMatch(/z-ai\/glm-5\.2/);
  });

  it('REGRESSION: bug-fix story\'s failing-file path uses $PROJECT_ROOT, not a hardcoded /tmp/skyscanner-app prefix (would point at a nonexistent path for the real project outputDir)', () => {
    expect(orchSrc).not.toMatch(/--arg ffile "\/tmp\/skyscanner-app/);
    const idx = orchSrc.indexOf('--arg ffile "');
    expect(idx).toBeGreaterThan(-1);
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    expect(line).toMatch(/\$\{PROJECT_ROOT\}/);
  });
});
