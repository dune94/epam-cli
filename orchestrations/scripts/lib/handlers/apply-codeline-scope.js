#!/usr/bin/env node
/**
 * WRITE A RESOLVED CODELINE SCOPE INTO THE PRD.
 *
 * Takes what discovery found and records it where every downstream consumer already looks:
 * project.outputDirs, plus project.outputDir for the single-codeline readers that predate it.
 * This is the same shape the Jira path's synthesizer writes, so nothing downstream can tell which
 * route produced it — which is the point.
 *
 * Generic: both inputs are arguments and no project is named anywhere.
 *
 *   argv[2]  the PRD, rewritten in place
 *   argv[3]  the discovery artefact
 *   stdout   one line naming what was written
 *
 * REFUSES TO OVERWRITE A DECLARED SCOPE. Resolution fills a gap; a project that declares its own
 * codelines has already answered the question, and re-answering it would let discovery overrule an
 * operator's explicit scope — the setting whose whole purpose is to bound what a run may touch.
 *
 * Written through a temporary file and rename, so an interrupted write never leaves a half-PRD.
 */
'use strict';

const fs = require('fs');

const [, , prdPath, discoveryPath] = process.argv;
if (!prdPath || !discoveryPath) {
  process.stderr.write('[apply-codeline-scope] usage: <prd.json> <codeline-discovery.json>\n');
  process.exit(1);
}

let prd, discovery;
try {
  prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
  discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
} catch (e) {
  process.stderr.write(`[apply-codeline-scope] cannot read inputs: ${e.message}\n`);
  process.exit(1);
}

prd.project = prd.project || {};
const existing = prd.project.outputDirs;
if (Array.isArray(existing) && existing.length) {
  process.stdout.write(
    `scope already declared (${existing.length} codeline(s)) — leaving it alone\n`);
  process.exit(0);
}

const codelines = Array.isArray(discovery.codelines) ? discovery.codelines : [];
if (!codelines.length) {
  // Loud. An empty scope written into the PRD is indistinguishable from a project that has none,
  // and the dispatch would read it as single-lane — the exact silent collapse this stage exists
  // to prevent.
  process.stderr.write('[apply-codeline-scope] discovery resolved no codelines — refusing to '
    + 'write an empty scope, which would read downstream as a single-lane project\n');
  process.exit(1);
}

prd.project.outputDirs = codelines.map((c) => ({ codeline: c.name, path: c.path }));
prd.project.outputDir = prd.project.outputDirs[0].path;

const tmp = `${prdPath}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(prd, null, 2)}\n`);
fs.renameSync(tmp, prdPath);

process.stdout.write(
  `scope resolved: ${prd.project.outputDirs.map((d) => d.codeline).join(', ')}\n`);
