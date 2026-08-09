/**
 * verify-findings — re-run a reviewer's own check, deterministically.
 *
 * WHY THIS EXISTS. The roster reviewer decides whether a generated roster is fit to build on.
 * On 2026-08-07 it reported, with a plausible account of what it had checked, that a codeline
 * did not declare a testing package. The package was in that codeline's devDependencies and
 * installed on disk. The claim was confidently wrong, and nothing in the pipeline noticed —
 * a retry would have produced the same answer, and a stronger model is no guarantee either,
 * because the failure is a careless read rather than a hard judgement.
 *
 * A finding that turns on "is this named thing present here" is mechanically settleable. The
 * reviewer states it in a structured field; this re-runs exactly that check and DISCARDS the
 * finding if the repository disagrees. A careless reading then costs nothing, and a correct
 * one is confirmed independently of how convincingly it was argued.
 *
 * NO ECOSYSTEM KNOWLEDGE LIVES HERE. Which manifest a project uses and which keys inside it
 * hold dependencies come from that project's own dependency-check.json — the same config the
 * dependency-contract plugin reads. The reviewer supplies the subject; the project supplies
 * the shape; this file supplies neither. Findings it cannot settle are kept untouched: an
 * ownership overlap or a piece of work nobody owns is a judgement, and refusing to rule on it
 * is the honest outcome, not a reason to drop it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Which manifest, and which keys — from the project's own config, never assumed. */
function manifestConfig(repoPath) {
  const candidates = [path.join(repoPath, '.epam', 'dependency-check.json')];
  if (process.env.EPAM_PROJECT_CONFIG_DIR) {
    candidates.push(path.join(process.env.EPAM_PROJECT_CONFIG_DIR, 'dependency-check.json'));
  }
  for (const c of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (typeof cfg.manifestFile === 'string' && Array.isArray(cfg.manifestKeys) && cfg.manifestKeys.length) {
        return { manifestFile: cfg.manifestFile, manifestKeys: cfg.manifestKeys };
      }
    } catch { /* try the next */ }
  }
  return null;
}

function declaredNames(repoPath) {
  const cfg = manifestConfig(repoPath);
  if (!cfg) return null;                       // cannot settle: no config, so no verdict
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoPath, cfg.manifestFile), 'utf8'));
    const names = new Set();
    for (const key of cfg.manifestKeys) {
      const section = manifest[key];
      if (section && typeof section === 'object') for (const n of Object.keys(section)) names.add(n);
    }
    return names;
  } catch { return null; }
}

/**
 * verifyFindings(findings, codelines) -> { kept, refuted, unsettled }
 *
 * kept      — the repository CONTRADICTS the brief (a real defect), or the finding is a
 *             judgement no tool settles.
 * refuted   — the repository AGREES with the brief, so there is no defect. Dropped.
 * unsettled — malformed (dropped), or checkable in principle but unrunnable (kept, flagged).
 */
function verifyFindings(findings, codelines) {
  const byName = new Map((Array.isArray(codelines) ? codelines : []).map((c) => [c.name, c.path]));
  const kept = [];
  const refuted = [];
  const unsettled = [];

  for (const f of (Array.isArray(findings) ? findings : [])) {
    const v = f && f.verification;

    // No verification block, or an explicit "no tool settles this": a judgement about
    // ownership, overlap or vagueness. The reviewer's to make, and kept untouched.
    if (!v || v.kind === 'not_mechanically_checkable') { kept.push(f); continue; }

    // A finding that claims a mechanical basis must supply the fields the check needs.
    // The schema declared none of them required, so live output carried {codeline, expected}
    // and nothing else — and the old code's `!v.kind` bail-out KEPT every such finding as a
    // trusted blocking defect. The whole re-check was inert in production (2026-08-08).
    // Malformed is now surfaced and NOT kept: an unverifiable claim must not halt a run.
    const subject = typeof v.subject === 'string' ? v.subject.trim() : '';
    if (!v.kind || !subject || !v.codeline || !v.expected) {
      unsettled.push({
        ...f,
        _why: 'malformed verification: a mechanically-checkable finding must name kind, ' +
          'codeline, subject and expected',
      });
      continue;
    }
    // briefAsserts may be absent on older payloads. Then only the reviewer's READ can be
    // checked, which is the 2026-08-07 protection; defect-ness cannot be settled, so the
    // finding is kept if the read holds. Stated rather than silently assumed.
    const briefAsserts = v.briefAsserts === 'present' || v.briefAsserts === 'absent'
      ? v.briefAsserts : null;

    const repo = byName.get(v.codeline);
    if (!repo) { unsettled.push({ ...f, _why: `no such codeline: ${v.codeline}` }); kept.push(f); continue; }

    let actuallyPresent = null;
    if (v.kind === 'dependency_declared') {
      const names = declaredNames(repo);
      if (names) actuallyPresent = names.has(subject);
    } else if (v.kind === 'path_exists') {
      // Contained within the codeline: a finding must not send this reading outside the repo.
      const target = path.resolve(repo, subject);
      if (target.startsWith(path.resolve(repo) + path.sep)) actuallyPresent = fs.existsSync(target);
    }

    if (actuallyPresent === null) { unsettled.push({ ...f, _why: 'the check could not be run' }); kept.push(f); continue; }

    // TWO questions, in order. They are different and a single comparison cannot answer both.
    //
    // 1. DID THE REVIEWER READ THE REPOSITORY CORRECTLY? `expected` is what it says it found.
    //    Live 2026-08-07 a reviewer reported a package absent from a codeline that declares it
    //    in devDependencies. A careless read must cost nothing, so a wrong read is refuted here
    //    and never reaches the second question.
    const reviewerSaysPresent = v.expected === 'present';
    if (actuallyPresent !== reviewerSaysPresent) {
      refuted.push({
        ...f,
        _refutedBy: `${v.kind}: "${subject}" is ${actuallyPresent ? 'present' : 'absent'} in ` +
          `${v.codeline}, the finding says ${reviewerSaysPresent ? 'present' : 'absent'}`,
      });
      continue;
    }

    // 2. GIVEN A CORRECT READ, IS THE BRIEF ACTUALLY WRONG? Only a contradiction between the
    //    brief and the repository is a defect. Live 2026-08-08 the reviewer raised NINE
    //    findings whose own evidence read "This claim is sound" — it verified the brief and
    //    reported it as blocking anyway, which burned the entire correction budget before a
    //    genuine defect arrived. A confirmed brief is not a finding.
    if (briefAsserts !== null && actuallyPresent === (briefAsserts === 'present')) {
      refuted.push({
        ...f,
        _refutedBy: `${v.kind}: the brief says "${subject}" is ${briefAsserts} in ${v.codeline}, ` +
          'and it is — the brief is correct, so this is not a defect',
      });
      continue;
    }

    kept.push({ ...f, _verified: true });
  }
  return { kept, refuted, unsettled };
}

module.exports = { verifyFindings, declaredNames, manifestConfig };
