#!/usr/bin/env node
/**
 * THE PROVIDERS THIS RUN CAN ACTUALLY ROUTE TO, AS A JSON ARRAY.
 *
 * The sibling of ladder-models.js, and asked for the same reason: the prd-model-coordinator writes
 * an aiProvider into every story, and until 2026-08-28 its persona named {minimax, openrouter} in prose.
 * On the claude stack that is a provider nothing can route, paired with a model no ladder declares.
 *
 * A provider is routable when the resolved provider set declares a RUNNER for it — the runner is
 * what actually launches the call, so a provider with no runner is a name and nothing more. Read,
 * never listed here: a set that declares other runners needs no change to this file.
 *
 * A SECOND, INDEPENDENT AUTHORITY: WHAT THE SET'S OWN CREDENTIALS AUTHORIZE. Found 2026-09-03: the
 * openrouter set declares $credentials for EPAM_API_KEY_OPENROUTER and EPAM_API_KEY_MINIMAX — real,
 * required credentials — but its runner is "claude" (the CLI binary invoked), so the routable list
 * was ["claude"] only, missing the two vendors the set exists to route to. That list is what this
 * codebase tells the prd-model-coordinator is PERMITTED (run-agent-orchestration.sh's
 * __MC_PERMITTED_PROVIDERS__) and, since 706469cf, what resolve_primary_provider() validates a
 * roster's aiProvider choice against — so the gap did not just under-inform the coordinator, it
 * meant a correct, deliberate per-story vendor choice (aiProvider: "minimax" under
 * EPAM_PROVIDER_SET=openrouter) got SILENTLY SUBSTITUTED away, the opposite of what that mechanism
 * exists to protect.
 */
try {
  // activeSetFile() is the resolver's own answer to "which set is in force", so the path
  // convention is not restated here — resolveLlmSettings() projects runners away.
  const { resolveLlmSettings, activeSetFile, activeSet } = require('../llm-settings-resolve.js');
  const st = resolveLlmSettings() || {};
  const setFile = activeSetFile();
  const raw = setFile ? JSON.parse(require('fs').readFileSync(setFile, 'utf8')) : {};
  const out = [];
  const seen = new Set();
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };

  // The ladders' own declaration wins where a tier names its provider; the runners are the
  // authority on what can be launched at all.
  for (const t of Object.values(st.ladders || {})) add(t && (t.provider || t.aiProvider));
  for (const name of Object.keys(raw.runners || {})) add(name);

  // WHAT THE SET'S OWN CREDENTIALS AUTHORIZE. The env name IS the vendor identity — EPAM_API_KEY_*
  // is the one place that mapping is declared (provider-sets.json), so it is derived, not
  // hardcoded here. A set with no credentials (claude, codemie, mockserver — all authenticate via
  // the claude CLI's own OAuth) adds nothing; this is additive and only ever WIDENS the list a
  // runner-only view already produced.
  const active = activeSet();
  const creds = active && active.cfg && Array.isArray(active.cfg.credentials) ? active.cfg.credentials : [];
  for (const c of creds) {
    const env = c && typeof c.env === 'string' ? c.env : '';
    const m = /^EPAM_API_KEY_([A-Z0-9_]+)$/.exec(env);
    if (m) add(m[1].toLowerCase());
  }

  // A set that declares no runners (openrouter routes by model, not by runner) still has an
  // authority: providers.json `known` is what the pre-flight validates a story's aiProvider
  // against, so agreeing with it is the difference between a PRD that passes and one that does not.
  if (!out.length) {
    const path = require('path');
    const known = JSON.parse(require('fs').readFileSync(
      path.join(path.dirname(setFile || '.'), 'providers.json'), 'utf8')).known || {};
    for (const name of (Array.isArray(known) ? known : Object.keys(known))) add(name);
  }

  process.stdout.write(JSON.stringify(out));
} catch {
  process.stdout.write('');
}
