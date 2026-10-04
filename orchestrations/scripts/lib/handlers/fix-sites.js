#!/usr/bin/env node
/**
 * fix-sites.js <prd.json> <story-id> — WHERE THE DETECTIVE FOUND THE FIX, as every consumer reads it.
 *
 * The spec pass persists the code-graph detective's findings on story.fixSiteAnalysis. The reviewer
 * rendered them with its own inline jq, the writer has its own blocks, and the two failure analysts
 * — which diagnose why the writer's attempt failed — were never shown them at all (2026-10-04): they
 * judged a failed attempt without knowing which files the fix belongs in, which the detective said
 * need no edit, or what minimal change it prescribed. One rendering, read by the reviewer and both
 * analysts.
 *
 * Prints nothing when the story has no findings (a greenfield story, or a spec pass that found none).
 */
'use strict';
const fs = require('fs');

function fixSitesFor(prd, storyId) {
  const story = (prd && Array.isArray(prd.stories) ? prd.stories : []).find((s) => s && s.id === storyId);
  const sites = story && Array.isArray(story.fixSiteAnalysis) ? story.fixSiteAnalysis : [];
  return sites.map((f) => {
    let line = `- **${f.file}**`;
    if (f.function) line += ` (\`${f.function}\`)`;
    if (f.changeRequired === false) {
      line += '  [NO EDIT REQUIRED — part of the fix, correctly left unchanged; never raise a finding because this file is untouched]';
    }
    line += `: ${f.reason == null ? 'null' : f.reason}`;
    if (f.fix) line += `\n  - Prescribed minimal fix: ${f.fix}`;
    return line;
  }).join('\n');
}

if (require.main === module) {
  const [prdFile, storyId] = process.argv.slice(2);
  if (!prdFile || !storyId) { process.stderr.write('usage: fix-sites.js <prd.json> <story-id>\n'); process.exit(2); }
  let prd;
  try { prd = JSON.parse(fs.readFileSync(prdFile, 'utf8')); } catch { process.exit(0); }
  process.stdout.write(fixSitesFor(prd, storyId));
}

module.exports = { fixSitesFor };
