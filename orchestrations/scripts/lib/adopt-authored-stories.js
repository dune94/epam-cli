'use strict';
/**
 * A RESUME TAKES THE STORIES THE OPERATOR HAS AUTHORED SINCE THE RUN BEGAN.
 *
 * A resumed greenfield run keeps its own PRD (resume_preserves prd-state): its splits, assignments,
 * spec blocks and statuses are the run's progress. The authored PRD is read only at a fresh launch,
 * so a story authored after the run began — regintel REGI-015/016, written from the live DIAL check of
 * run 20260926T125158Z's own output — could reach the run only by rebuilding everything from nothing.
 *
 * Adoption is additive and nothing else: a story whose id the run's PRD does not hold is appended as
 * pending, in the phase the authored PRD places it, after that phase's existing stories. Nothing the
 * run holds is changed — a split parent is still present (deprecated) under its authored id, so it is
 * never adopted again. The adopted story then meets the same steps any unelaborated story does: role
 * assignment (only stories without a role are asked about), the spec pass (only stories lacking spec
 * output), the model coordinator, and the writer.
 */
const fs = require('fs');

function adoptAuthoredStories(runPrd, canonical) {
  const have = new Set((runPrd.stories || []).map((s) => s.id));
  const order = runPrd.implementationOrder = runPrd.implementationOrder || {};
  const adopted = [];
  for (const s of (canonical && canonical.stories) || []) {
    if (!s || !s.id || have.has(s.id)) continue;
    const phase = Object.keys(canonical.implementationOrder || {})
      .find((p) => (canonical.implementationOrder[p] || []).includes(s.id));
    if (!phase) continue;                       // authored but placed in no phase: nothing to run
    const story = JSON.parse(JSON.stringify(s));
    story.status = 'pending';
    story.completed = false;
    runPrd.stories.push(story);
    order[phase] = [...(order[phase] || []), s.id];
    have.add(s.id);
    adopted.push({ id: s.id, phase });
  }
  return adopted;
}

module.exports = { adoptAuthoredStories };

// CLI: node adopt-authored-stories.js <run-prd.json> <canonical.json> — rewrites the run PRD atomically
// when anything was adopted, and prints one line per adopted story.
if (require.main === module) {
  const [prdFile, canonicalFile] = process.argv.slice(2);
  if (!prdFile || !canonicalFile) { console.error('usage: adopt-authored-stories.js <run-prd.json> <canonical.json>'); process.exit(2); }
  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  const canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
  const adopted = adoptAuthoredStories(prd, canonical);
  for (const a of adopted) console.log(`adopted authored story ${a.id} into phase '${a.phase}'`);
  if (adopted.length) {
    const tmp = `${prdFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prd, null, 2) + '\n');
    fs.renameSync(tmp, prdFile);
  }
}
