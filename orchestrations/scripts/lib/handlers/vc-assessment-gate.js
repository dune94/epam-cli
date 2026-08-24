#!/usr/bin/env node
/**
 * AN APPROVAL THAT NAMES NO CRITERION CANNOT BE WRONG, AND SO CANNOT BE RIGHT.
 *
 * The reviewer is handed the story's verification criteria — "the observable checks this change
 * MUST satisfy" — and its output contract asked only for a verdict, issues and a summary. So
 * "approved" never had to say which criterion it checked or what it read, and nothing in the
 * artefact could be falsified by anyone afterwards.
 *
 * Live 20260821T212250Z: the approval missed a dropped cleanup its own earlier cycle had caught,
 * and the review output records no criteria at all.
 *
 * WHAT THIS ENFORCES, AND WHY IT STOPS THERE.
 *
 *   SELF-CONTRADICTION IS REJECTED. Approving while the reviewer's OWN assessment marks a
 *   criterion unmet is incoherent. Rejecting that is ALWAYS SATISFIABLE — the model needs only
 *   to be consistent with itself, so this can never become a gate a run cannot pass.
 *
 *   INCOMPLETENESS IS REPORTED, NOT BLOCKED. Requiring an entry per criterion before a run may
 *   approve would be a gate a model can fail forever, which is the unwinnable-retry shape this
 *   pipeline has already paid for twice. Unassessed criteria are recorded on the verdict, in
 *   the artefact, where the next reader and the next cycle can both see them.
 *
 * Reads a review payload on stdin, writes it back on stdout. Unparseable input is passed
 * THROUGH unchanged: a gate that swallows a bad response turns it into no response, and the
 * caller's own no-verdict handling is what should see that.
 *
 *   node vc-assessment-gate.js "<criteria, one per line>"
 */
'use strict';

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

/** Criteria the reviewer never spoke to. Matched loosely: a model restates, it does not quote. */
function unassessed(criteria, assessment) {
  const seen = assessment.map((a) => norm(a && a.criterion)).filter(Boolean);
  return criteria.filter((c) => {
    const n = norm(c);
    if (!n) return false;
    return !seen.some((s) => s === n || s.includes(n) || n.includes(s));
  });
}

function judge(review, criteria) {
  const assessment = Array.isArray(review.vcAssessment) ? review.vcAssessment : [];

  // Only an approval can contradict itself into a problem; a rejection is already a rejection
  // and must never be upgraded here.
  if (review.verdict === 'approved') {
    const unmet = assessment.filter((a) => a && a.met === false);
    if (unmet.length) {
      return {
        ...review,
        verdict: 'changes_requested',
        vcAssessmentContradiction: true,
        issues: [
          ...unmet.map((a) => ({
            severity: 'blocker',
            file: '',
            line: 0,
            description:
              `approved while your own assessment marks this verification criterion UNMET: `
              + `"${a.criterion}". A criterion the change does not satisfy is not approvable.`,
            // The reviewer's OWN evidence, carried forward. Restating the claim here would
            // throw away the one thing that makes the finding checkable.
            evidence: String(a.evidence || '(the assessment gave no evidence)'),
            suggestedFix: 'Satisfy the criterion, or explain in the assessment why it is met.',
          })),
          ...(Array.isArray(review.issues) ? review.issues : []),
        ],
      };
    }
  }

  if (criteria.length) {
    const missing = unassessed(criteria, assessment);
    if (missing.length) {
      // Recorded on the verdict, not enforced. See the header.
      return { ...review, vcAssessmentIncomplete: true, vcAssessmentUnassessed: missing };
    }
  }
  return review;
}

function main() {
  const criteria = String(process.argv[2] || '')
    .split('\n').map((s) => s.replace(/^\s*[-*\d.)\]]+\s*/, '').trim()).filter(Boolean);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let review;
    try { review = JSON.parse(raw); } catch { process.stdout.write(raw); return; }
    if (!review || typeof review !== 'object' || Array.isArray(review)) { process.stdout.write(raw); return; }
    process.stdout.write(JSON.stringify(judge(review, criteria)));
  });
}

if (require.main === module) main();
module.exports = { judge, unassessed };
