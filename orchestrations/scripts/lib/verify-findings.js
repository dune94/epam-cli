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
 * kept      — confirmed by the repository, or not mechanically checkable (a judgement).
 * refuted   — the repository contradicts the finding. Dropped.
 * unsettled — checkable in principle, but the check could not run. Kept, and flagged.
 */
function verifyFindings(findings, codelines) {
  const byName = new Map((Array.isArray(codelines) ? codelines : []).map((c) => [c.name, c.path]));
  const kept = [];
  const refuted = [];
  const unsettled = [];

  for (const f of (Array.isArray(findings) ? findings : [])) {
    const v = f && f.verification;
    if (!v || !v.kind || v.kind === 'not_mechanically_checkable') { kept.push(f); continue; }

    const repo = byName.get(v.codeline);
    const subject = typeof v.subject === 'string' ? v.subject.trim() : '';
    const expectPresent = v.expected === 'present';
    if (!repo || !subject) { unsettled.push({ ...f, _why: 'no such codeline, or no subject named' }); kept.push(f); continue; }

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
    if (actuallyPresent === expectPresent) { kept.push({ ...f, _verified: true }); }
    else {
      refuted.push({
        ...f,
        _refutedBy: `${v.kind}: "${subject}" is ${actuallyPresent ? 'present' : 'absent'} in ${v.codeline}, ` +
          `the finding says ${expectPresent ? 'present' : 'absent'}`,
      });
    }
  }
  return { kept, refuted, unsettled };
}

module.exports = { verifyFindings, declaredNames, manifestConfig };
