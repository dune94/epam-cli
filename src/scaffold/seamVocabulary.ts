// ── The names the mint may propose, derived from the registry that routes them ──────────────
//
// The agent-proposal template used to spell the vocabulary out in English — 'ending in
// "-engineer" or "-specialist"' — while the invocation registry decided, in regexes, which
// shapes actually resolve. `specialist` appears in none of the twenty rules, so half the
// vocabulary the mint was authorised to use threw at resolveSeam and killed the run at mint.
// Which half it picked was the model's choice of wording. A third copy of the same list sat in
// the response schema's description of `name`.
//
// Nothing is written here. Each seamPattern already declares the KIND it serves and the SEAM it
// routes to, so the vocabulary is read out of the rules themselves: add a rule tomorrow and the
// prompt offers it without an edit, remove one and the prompt stops offering it. The mint cannot
// be handed a shape the pipeline cannot route, which is the difference between guaranteeing
// resolution and policing it afterwards.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { engineRoot } from '../prompts/templatesDir';

/** One name-shape rule as the registry declares it. */
type SeamPattern = { match?: string; seam?: string; kind?: string };
export type InvocationRegistry = { seamPatterns?: SeamPattern[]; profiles?: Record<string, unknown> };

/**
 * The registry file. Same override the orchestration side honours (AGENT_PROFILES_REGISTRY), so
 * a project pointing the pipeline at its own registry gets a prompt derived from THAT one.
 */
export function registryPath(): string {
  const override = process.env.AGENT_PROFILES_REGISTRY;
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(engineRoot(), 'orchestrations', 'agents', 'invocation-profiles.json');
}

export function readRegistry(): InvocationRegistry {
  const file = registryPath();
  if (!existsSync(file)) {
    throw new Error(
      `[seam-vocabulary] the invocation registry does not exist: ${file}. The mint's naming rule `
      + 'is derived from it and will not be guessed at.');
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InvocationRegistry;
  } catch (e) {
    throw new Error(`[seam-vocabulary] cannot read ${file}: ${(e as Error).message}`);
  }
}

/**
 * A rule's literal suffix, or null when it does not state one.
 *
 * Only the `(^|-)word$` shape — the one every rule in the registry uses — yields a suffix a
 * prompt can quote. Anything else is a pattern the mint cannot be told about in one word, and is
 * skipped rather than approximated: offering a shape the model would have to guess at is the
 * defect this module exists to remove.
 */
function suffixOf(match: string | undefined): string | null {
  const m = /^\(\^\|-\)([a-z][a-z0-9]*)\$$/.exec(String(match || ''));
  return m ? m[1] : null;
}

/** Every name suffix the mint may use, by the kind it serves. Derived, never written. */
export function mintNameVocabulary(registry?: InvocationRegistry): Record<string, string[]> {
  const reg = registry || readRegistry();
  const out: Record<string, string[]> = {};
  for (const rule of reg.seamPatterns || []) {
    if (!rule || !rule.kind || !rule.seam) continue;      // no kind: not a roster shape
    const suffix = suffixOf(rule.match);
    if (!suffix) continue;
    (out[rule.kind] = out[rule.kind] || []).push(suffix);
  }
  for (const kind of Object.keys(out)) out[kind] = [...new Set(out[kind])].sort();
  return out;
}

/** `"-a", "-b" or "-c"` — the shapes for one kind, as a prompt can quote them. */
function quoteSuffixes(suffixes: string[]): string {
  const q = suffixes.map((s) => `"-${s}"`);
  if (q.length === 1) return q[0];
  return `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`;
}

/**
 * The naming rule as the mint reads it: one line per kind, naming only shapes that resolve.
 *
 * @throws when the registry declares no roster shape at all — a mint told to name roles with no
 *         permitted shape would propose names the pipeline then refuses, one stage later.
 */
export function mintNameRule(registry?: InvocationRegistry): string {
  const vocab = mintNameVocabulary(registry);
  const kinds = Object.keys(vocab).sort();
  if (!kinds.length) {
    throw new Error(
      '[seam-vocabulary] the invocation registry declares no seamPattern carrying a `kind`, so '
      + 'there is no name shape the mint may legally propose. Add a rule with a kind before '
      + 'minting, or the roster cannot be routed.');
  }
  // No article before the kind: the kind names come from the registry, so "a"/"an" cannot be
  // chosen here without writing a rule about words the registry is free to change.
  const lines = kinds.map((kind) => `  - ${kind}: ends in ${quoteSuffixes(vocab[kind])}`);
  return [
    '- name: kebab-case, "<domain>-<suffix>", where the suffix is fixed by the kind:',
    ...lines,
    '  No other ending is routable — a name outside these shapes cannot be assigned to any seam',
    '  and the run stops at the mint.',
  ].join('\n');
}
