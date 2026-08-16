#!/usr/bin/env node
/**
 * WRITE THE CODELINE FACTS THIS RUN DISCOVERED.
 *
 * codeline-facts.json tells an agent working inside a repository the things it cannot read off
 * the source: that this one's pre-commit hook dies at import time unless four env vars are set,
 * that that one's tests need a live index. run-agent-orchestration.sh splits it per codeline and
 * drops each slice into that worktree's .epam/, so the agents there see their own codeline's.
 *
 * NOTHING PRODUCED IT. Every one in the repo was typed by hand into a project directory, and the
 * only code touching it was the split that distributes what a human wrote. A new project
 * therefore had no facts at all, and whatever a run learned died with the run.
 *
 * ONE PRODUCER. Discovery emits them, because it is the stage that scans the whole estate and
 * sees every codeline at once. The detective stays a consumer — it already declares
 * `consumes: codeline-facts`. Two producers would be incoherent given the rule below: the second
 * to write would silently overwrite the first.
 *
 * REGENERATED, NEVER ACCUMULATED. Operator, 2026-08-16: "no it does not accumulate over runs."
 * The file is exactly what THIS run's discovery found. A fact that outlives the run that
 * observed it is a fact nobody re-checks, and a wrong one would outlive every right one.
 *
 * THE SHAPE IS NOT NEGOTIABLE. The engine reads it with `jq '.[$cl]'` — codeline names at the
 * TOP LEVEL. A file nesting them one level down parses fine, satisfies every structural check
 * anyone writes in JS, and returns empty for every codeline. That is not a hypothetical: the
 * hand-written mock3 file did exactly that, and the provisioning step skipped it in silence.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write this run's codeline facts into the project directory.
 *
 * @param {object}   o
 * @param {string}   o.projectConfigDir  the project's own config directory
 * @param {Array}    o.codelines         discovery's selections, each optionally carrying facts[]
 * @param {Function} [o.warn]            where to report a codeline that produced no facts
 * @returns {{path:string, codelines:string[], withoutFacts:string[]}}
 */
function writeCodelineFacts({ projectConfigDir, codelines, warn = () => {} }) {
  if (!projectConfigDir) {
    // Guessing a location would provision a project nobody asked for — the same rule the prompt
    // builder follows for the same reason.
    throw new Error(
      '[codeline-facts] projectConfigDir is required: there is nowhere to write this run\'s '
      + 'codeline facts, and inventing a location would write them into a project nobody named.');
  }
  const list = Array.isArray(codelines) ? codelines : [];
  if (!list.length) {
    throw new Error('[codeline-facts] discovery returned no codelines, so there is nothing to describe');
  }

  const out = {
    _what: 'What each codeline IS and what an agent working inside it needs to know that the '
      + 'source does not say. Produced by the codeline-discovery agent during THIS run and '
      + 'rewritten every run — never accumulated, so nothing here is older than the run that '
      + 'wrote it. The engine splits this per codeline into each worktree\'s .epam/.',
    _shape: 'Codeline names are TOP-LEVEL keys, because the engine extracts one with '
      + "jq '.[$cl]'. Nesting them under another key parses fine and yields nothing for every "
      + 'codeline.',
  };

  const withoutFacts = [];
  for (const cl of list) {
    const name = cl && cl.name;
    if (!name) continue;
    const facts = Array.isArray(cl.facts) ? cl.facts.filter((f) => f && String(f.text || '').trim()) : [];

    if (!facts.length) {
      // SAY SO. The provisioning step skips a codeline whose entry is empty, so "the agent
      // returned nothing", "the file is malformed" and "there is no file" are one observation
      // downstream. The codeline is still written: omitting it would make "no facts" look
      // identical to "never discovered".
      withoutFacts.push(name);
      warn(`[codeline-facts] the discovery agent returned no facts for codeline '${name}' — `
        + 'agents working there will have nothing beyond the source itself');
    }

    out[name] = {
      path: cl.path || '',
      facts: facts.map((f) => ({
        text: String(f.text).trim(),
        // A fact with no source cannot be checked, and an unsourced wrong one is indistinguishable
        // from a right one to every agent that reads it afterwards.
        source: String(f.source || '').trim() || '(unsourced — the agent gave no origin)',
      })),
    };
  }

  const file = path.join(projectConfigDir, 'codeline-facts.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return { path: file, codelines: Object.keys(out).filter((k) => !k.startsWith('_')), withoutFacts };
}

module.exports = { writeCodelineFacts };
