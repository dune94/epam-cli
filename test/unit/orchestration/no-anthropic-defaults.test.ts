/**
 * No orchestration script may DEFAULT to an Anthropic model/provider.
 *
 * This pipeline runs on OpenRouter (provider `openrouter`, models z-ai/glm-5.x,
 * moonshotai/kimi-*). Found 2026-07-25 by a static parameter audit: 8 sites
 * carried `${ORCH_GATE_PROVIDER:-anthropic}` / `${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}`
 * as their fallback, including the two most consequential brownfield steps —
 * AC elaboration and CODELINE SELECTION.
 *
 * They were invisible because the tier3 runner exports both vars, so the fallback
 * only fires on some other launch path (orchestrate.sh, a direct call, a test) —
 * where it silently routes to a different vendor, or worse pairs them:
 * `epam run --provider openrouter --model claude-haiku-4-5-20251001`.
 *
 * The user's question when this class first surfaced: "why are you using claude
 * models for testing when we are not using in pipeline?" A default is a silent
 * version of the same mistake.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* files(join(dir, e.name));
    else if (/\.(sh|js)$/.test(e.name)) yield join(dir, e.name);
  }
}

/** `${VAR:-anthropic}` / `|| 'claude-...'` — a DEFAULT, not a legitimate mention. */
const ANTHROPIC_DEFAULT =
  /(:-\s*(anthropic|claude-[a-z0-9.-]+)\}|\|\|\s*['"](anthropic|claude-[a-z0-9.-]+)['"])/;

describe('no Anthropic defaults in a openrouter/OpenRouter pipeline', () => {
  it('no script falls back to an Anthropic provider or model', () => {
    const hits: string[] = [];
    for (const f of files(SCRIPTS)) {
      // codemie-claude.sh is the CodeMie provider adapter; 'claude-sonnet' there names
      // a CLI to invoke, not a model default for this pipeline.
      if (/codemie-claude\.sh$/.test(f)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/CLAUDE_CMD|codemie|^\s*#/.test(line)) return;
        if (ANTHROPIC_DEFAULT.test(line)) hits.push(`${f.replace(SCRIPTS + '/', '')}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(hits, 'these silently route to Anthropic when the env var is unset').toEqual([]);
  });

  it('gate timeouts allow for a reasoning model', () => {
    // `timeout 60 epam run` against glm-5.2: the model is still thinking when it is
    // killed, so the gate yields nothing and the retry burns too.
    const src = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
    const short = [...src.matchAll(/timeout\s+(\d+)\s+epam run/g)]
      .filter(m => Number(m[1]) < 300).map(m => `timeout ${m[1]} epam run`);
    expect(short, 'too short for a reasoning model').toEqual([]);
  });
});
