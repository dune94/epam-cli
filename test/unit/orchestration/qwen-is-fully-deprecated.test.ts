/**
 * QWEN IS GONE, AND OPENROUTER IS WHAT REPLACED IT.
 *
 * The operator asked for this two weeks ago and it was never completed. What survived was not one
 * stale value but five layers, each of which alone makes the deprecation false:
 *
 *   .env                      EPAM_ORCHESTRATION_PROVIDER=qwen — the value that actually routed
 *   the openrouter SET        lists qwen FIRST in its routable providers
 *   orchestrator dispatch     accepts qwen, and REJECTS openrouter outright
 *   orchestrations/scripts    ~165 references
 *   src/                      the provider implementation plus ~36 references
 *
 * A partial removal is worse than none: setting the value the operator asked for was IMPOSSIBLE,
 * because the pipeline accepted only the provider that no longer exists. A run launched that way
 * dies at startup with "Unknown EPAM_ORCHESTRATION_PROVIDER 'openrouter'".
 *
 * This is the finish line. It fails while any layer still names qwen as a provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const CONFIG = join(REPO, 'orchestrations/config');

/** Files that may legitimately still mention it: history, and this test. */
const ALLOWED = /(^|\/)(change-log|CHANGELOG|docs|\.git|node_modules|test\/reports|logs)(\/|$)|qwen-is-fully-deprecated/;

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (ALLOWED.test(p)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.test(e)) out.push(p);
  }
  return out;
}

/**
 * A PROVIDER REFERENCE, NOT A MODEL NAME.
 *
 * qwen names two different things and only one of them is being removed:
 *
 *   the PROVIDER  — a routing target, an aiProvider value, a dispatch arm. Dead: it was a
 *                   ten-line shim that exec'd claude.sh, and OpenRouter replaced it.
 *   MODEL IDS     — `qwen/qwen3-235b-a22b`, `openrouter/qwen3-coder`, `qwen2.5:1.5b`. Real models
 *                   from a third party, sold THROUGH OpenRouter and priced in model-pricing.json.
 *
 * Deleting the second kind would not deprecate a provider; it would make those models unpriceable
 * if anything ever selected one, which is a cost-tracking failure rather than a cleanup.
 */
const MODEL_ID = /qwen[0-9]|qwen\/|qwen-2\.5|qwen-max|qwen-plus|qwen-turbo|openrouter\/qwen/i;
/**
 * A MODEL-FAMILY ALTERNATION IS ALSO A MODEL REFERENCE.
 *
 * mock-expectations matches captured model names with /^(minimax|glm|kimi|qwen|z-ai|...)/ —
 * every alternative there is a model family, so `qwen` names qwen3-* and not the provider.
 * Renaming it would stop the harness recognising models that still exist.
 */
const MODEL_FAMILY_LIST = /minimax|glm|kimi|z-ai|zhipuai|moonshotai/i;
const PROSE = /^\s*(#|\/\/|\*|")/;

function mentions(files: string[]): Array<{ file: string; lines: string[] }> {
  return files
    .map((f) => ({
      file: f.replace(REPO, ''),
      lines: readFileSync(f, 'utf8').split('\n')
        .filter((l) => /qwen/i.test(l))
        .filter((l) => !MODEL_ID.test(l))            // a model name is not a provider
        .filter((l) => !MODEL_FAMILY_LIST.test(l))  // nor is one listed among model families
        .filter((l) => !PROSE.test(l.trim())) // a comment recording history is not a live reference
        .map((l) => l.trim().slice(0, 90)),
    }))
    .filter((r) => r.lines.length > 0);
}

describe('qwen is fully deprecated', () => {
  it('the dispatch shim is gone', () => {
    expect(existsSync(join(SCRIPTS, 'qwen.sh')),
      'qwen.sh still exists — the dispatch table can still route to it').toBe(false);
  });

  it('the provider implementation is gone', () => {
    expect(existsSync(join(REPO, 'src/providers/qwen')),
      'src/providers/qwen still exists').toBe(false);
    // RENAMED, NOT DELETED: QwenProvider WAS the OpenRouter implementation — ProviderChain built
    // it for an OPENROUTER_API_KEY, and MiniMaxProvider imports shared helpers from it. Deleting
    // it broke the build; it now lives at openrouter/OpenRouterProvider.ts.
    expect(existsSync(join(REPO, 'src/providers/openrouter/OpenRouterProvider.ts')),
      'the OpenRouter provider implementation is missing').toBe(true);
  });

  it('the orchestrator dispatch accepts openrouter', () => {
    // The layer that made the operator's instruction impossible to follow: openrouter was rejected
    // outright, so the only accepted value was the provider being removed.
    const orch = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
    expect(orch, 'openrouter is still not an accepted EPAM_ORCHESTRATION_PROVIDER')
      .toMatch(/^\s*openrouter\)\s+CLAUDE_SH=/m);
    expect(orch, 'qwen is still an accepted provider').not.toMatch(/^\s*qwen\)\s+CLAUDE_SH=/m);
  });

  it('no orchestration config names it', () => {
    const found = mentions(walk(CONFIG, /\.json$/));
    expect(found, `config still routes to qwen:\n${found.map((f) => `${f.file}: ${f.lines.join(' | ')}`).join('\n')}`)
      .toEqual([]);
  });

  it('no orchestration script names it', () => {
    const found = mentions(walk(SCRIPTS, /\.(sh|js)$/));
    expect(found, `scripts still name qwen:\n${found.map((f) => `${f.file} (${f.count})`).join('\n')}`)
      .toEqual([]);
  });

  it('no source file names it', () => {
    const found = mentions(walk(join(REPO, 'src'), /\.ts$/));
    expect(found, `src still routes to qwen:\n${found.map((f) => `${f.file}: ${f.lines.join(' | ')}`).join('\n')}`)
      .toEqual([]);
  });
});
