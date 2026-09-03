#!/usr/bin/env node
/**
 * WHAT THIS AGENT KNOWS ABOUT THIS PROJECT — DERIVED, NEVER TYPED.
 *
 * A skill is project knowledge an agent is expected to hold before it starts: how this codeline
 * runs its tests, what the pipeline has already learned working on it, which repository it is
 * touching. None of that is a property of the archetype — an -investigator on a Rust service and
 * an -investigator on a Node front end are the same seam and need different knowledge.
 *
 * So nothing here is declared per seam. Everything is resolved at invocation from what the project
 * already has:
 *
 *   ecosystem   lib/ecosystem-registry.js — the stack, its manifest, how it installs and runs tests
 *   learned     the KB the pipeline itself wrote while working on this codeline, plus the shared
 *               KB for lessons belonging to no single codeline. This is the one store meant to
 *               survive between runs, and an agent that cannot see it repeats what was learned
 *   scope       which codeline this invocation is for, and where it is
 *
 * An agent with no codeline (a coordinator, a reviewer of the PRD) still gets the shared KB and
 * the project's ecosystems, because "what this project is" applies to it too.
 *
 *   argv[2]  the codeline path this invocation is for ('' when the agent has no single codeline)
 *   argv[3]  the agents dir, which holds the KB files
 *   argv[4]  optional: comma-separated paths of every codeline in scope, for the no-codeline case
 *
 *   stdout   one JSON object: { codeline, stack, testCommand, learned, sources }
 *
 * EMPTY IS AN ANSWER. A project on its first run has no KB, and reporting that honestly is
 * correct — inventing knowledge an agent has not earned is how a confident wrong answer starts.
 */
'use strict';

// HOW LONG A LOCAL TOOL MAY TAKE IS DECLARED, not written here. This was the literal 20000 at
// two call sites — one decision with two homes, so a codeline large enough to need longer got a
// truncated scan in both, and raising it meant finding both.
function localToolTimeoutMs(configPath) {
  try {
    return JSON.parse(require('fs').readFileSync(configPath, 'utf8')).timeouts.localToolMs;
  } catch { return undefined; }
}

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const codelinePath = process.argv[2] || '';
const agentsDir = process.argv[3] || path.join(__dirname, '..', '..', '..', 'agents');
const allCodelines = (process.argv[4] || '').split(/[,:]/).map((s) => s.trim()).filter(Boolean);

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** The name a codeline is known by, from its path — the same derivation the pipeline uses. */
function codelineName(p) {
  if (!p) return '';
  try {
    return require('../codeline-name.js').deriveCodelineName(path.basename(p));
  } catch {
    return path.basename(p);
  }
}

/** Everything the ecosystem registry knows about one repository. */
function ecosystemOf(repo) {
  if (!repo) return null;
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'codeline-ecosystem.js'), repo,
    ], { encoding: 'utf8', timeout: localToolTimeoutMs(path.join(__dirname, '..', '..', '..', 'config', 'spec-mode-defaults.json')) });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const name = codelineName(codelinePath);
const sources = [];

// ── What the pipeline has already learned ────────────────────────────────────
// Per-codeline first, then shared. A lesson about mocka must not be handed to an agent working
// on mockb as though it were true there — that is why the KB is keyed per codeline at all.
const learned = [];
for (const [file, label] of [
  [name ? path.join(agentsDir, `KB-${name}.md`) : '', `KB for ${name}`],
  [path.join(agentsDir, 'KB-shared.md'), 'shared KB'],
]) {
  if (!file) continue;
  const text = read(file);
  // A KB SHIPS WITH A HEADER; A HEADER IS NOT KNOWLEDGE.
  //
  // Every KB file starts with a title and a paragraph explaining what the store is for. Measuring
  // length alone counted that paragraph as learning, and an agent would have been handed a
  // description of the KB mechanism instead of anything about the project.
  //
  // The pipeline appends entries as "## section" headings and "- fact" bullets, so an entry is
  // what distinguishes a KB that has learned something from one that has only been created.
  const entries = text.split('\n')
    .filter((l) => /^\s*(##+\s|[-*]\s)/.test(l))
    .join('\n')
    .trim();
  if (entries) {
    learned.push({ source: label, text: entries });
    sources.push(file);
  }
}

// ── What this codeline is ────────────────────────────────────────────────────
const scope = codelinePath ? [codelinePath] : allCodelines;
const stacks = [];
for (const repo of scope) {
  const eco = ecosystemOf(repo);
  if (!eco || !eco.stack) continue;
  stacks.push({
    codeline: codelineName(repo),
    path: repo,
    stack: eco.stack,
    manifest: eco.manifest,
    testCommand: eco.testCommand,
    declaredDeps: eco.declaredDeps || [],
  });
  sources.push(path.join(repo, eco.manifest));
}

process.stdout.write(`${JSON.stringify({
  codeline: name || null,
  stacks,
  learned,
  sources,
  empty: !stacks.length && !learned.length,
}, null, 2)}\n`);
