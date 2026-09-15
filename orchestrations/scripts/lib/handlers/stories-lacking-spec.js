#!/usr/bin/env node
/**
 * WHICH PENDING STORIES OF A PHASE CARRY NO SPEC OUTPUT?
 *
 * The spec pass elaborates a story and records it under specification.appliedAgents (the same
 * mark spec-mode-runner uses to count a story as specified). On a resume the run mode turns the
 * whole spec pass off, which is right only while EVERY pending story was elaborated; a story
 * whose content the remediation restored from canonical (its elaboration had gone to a
 * placeholder child, regintel run 20260915T101555Z) reached the writer with no spec. This names
 * the stories that still need the pass, so the resume runs it for them and them alone.
 *
 * Generic: the PRD is an argument; nothing here names a project, a stack or a story.
 *
 *   argv[1]  the PRD
 *   argv[2]  a phase (optional; every phase when absent)
 *   stdout   the story ids, one per line; nothing when every pending story is specified
 */
const fs = require('fs');

function storiesLackingSpec(prd, phase) {
  const byId = new Map((prd.stories || []).map((s) => [s.id, s]));
  const ids = phase
    ? ((prd.implementationOrder || {})[phase] || [])
    : Object.values(prd.implementationOrder || {}).flat();
  return ids
    .map((id) => byId.get(id))
    .filter((s) => s && s.completed !== true && s.status !== 'deprecated')
    .filter((s) => !(s.specification && Array.isArray(s.specification.appliedAgents) && s.specification.appliedAgents.length > 0))
    .map((s) => s.id);
}

module.exports = { storiesLackingSpec };

if (require.main === module) {
  try {
    const prd = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const out = storiesLackingSpec(prd, process.argv[3] || '');
    if (out.length) process.stdout.write(out.join('\n') + '\n');
  } catch (e) {
    process.stderr.write(`[stories-lacking-spec] ${e.message}\n`);
    process.exit(2);
  }
}
