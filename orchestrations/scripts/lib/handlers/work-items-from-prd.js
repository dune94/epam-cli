#!/usr/bin/env node
/**
 * THE WORK ITEMS IN A PRD, IN THE SHAPE DISCOVERY READS.
 *
 * Codeline discovery asks one question — which repository does this work belong to — and it asks
 * it of WORK ITEMS: key, title, description, and the components the tracker says are touched. It
 * does not care where those items came from.
 *
 * They used to come only from Jira, so discovery was invoked only on the Jira path, and a project
 * whose PRD is authored rather than ingested could never resolve its codelines. A PRD story
 * already carries every field discovery reads; this is the adapter that says so.
 *
 * Generic: the PRD path is an argument, and every project has a PRD however it arrived.
 *
 *   argv[2]  the PRD
 *   stdout   a work-items array: [{ jiraKey, title, description, components }]
 *
 * COMPONENTS ARE THE STRONGEST SIGNAL discovery has — the tracker's own statement of which product
 * areas a change touches, weighed as evidence rather than as a hint. A story's own `codelines`
 * carries the same meaning when a human authored the PRD, so both feed the field, deduplicated and
 * in a stable order. Empty is allowed: discovery then works from title and description, which is
 * what it does for a ticket whose components were never filled in.
 *
 * An unreadable PRD is fatal. Emitting an empty list would let discovery run against nothing and
 * report that no codeline matched, which reads like a finding rather than a missing input.
 */
'use strict';

const fs = require('fs');

const prdPath = process.argv[2];
if (!prdPath) {
  process.stderr.write('[work-items-from-prd] usage: <prd.json>\n');
  process.exit(1);
}

let prd;
try {
  prd = require('./_read-input.js').readJsonOrRefuse(prdPath, 'the PRD', { expect: 'object' });
} catch (e) {
  process.stderr.write(`[work-items-from-prd] cannot read ${prdPath}: ${e.message}\n`);
  process.exit(1);
}

const stories = Array.isArray(prd.stories) ? prd.stories : [];
if (!stories.length) {
  process.stderr.write(`[work-items-from-prd] ${prdPath} declares no stories\n`);
  process.exit(1);
}

const items = stories.map((s) => {
  const components = [
    ...(Array.isArray(s.components) ? s.components : []),
    ...(Array.isArray(s.codelines) ? s.codelines : []),
  ].filter(Boolean);

  return {
    jiraKey: s.jiraKey || s.id || '',
    title: s.title || '',
    description: s.description || '',
    components: [...new Set(components)],
  };
});

process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
