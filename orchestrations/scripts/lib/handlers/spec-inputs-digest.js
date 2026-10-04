#!/usr/bin/env node
/**
 * spec-inputs-digest.js [orchestrationsDir] — WHAT A LANE'S SPECIFICATION WAS BUILT FROM, as one digest.
 *
 * config/spec-inputs.json declares it: the seams that produce the specification (by what they
 * PRODUCE in the registry, never by name) — each one's base SI and every template file of its
 * template family — and the SI contract's sections every agent receives. A lane's pre-writer
 * checkpoint records this; a resume compares it (lib/run-checkpoint.sh lane_spec_is_current).
 *
 * Prints a sha256 hex digest; nothing when the declaration cannot be read.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function specInputsDigest(orchDir) {
  const decl = JSON.parse(fs.readFileSync(path.join(orchDir, 'config', 'spec-inputs.json'), 'utf8'));
  const reg = JSON.parse(fs.readFileSync(path.join(orchDir, 'agents', 'invocation-profiles.json'), 'utf8'));
  const contract = JSON.parse(fs.readFileSync(path.join(orchDir, 'config', 'agent-contract.json'), 'utf8'));
  const tplDir = path.join(orchDir, 'prompts', 'templates');
  const tplFiles = fs.readdirSync(tplDir).filter((f) => f.endsWith('.json')).sort();
  const produces = new Set(decl.produces || []);
  const parts = [];
  for (const [seam, p] of Object.entries(reg.profiles || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!p || !produces.has(p.produces)) continue;
    parts.push(['seam', seam, p.si || '']);
    const t = p.template;
    if (!t) continue;
    // The template and its family (<template>.<variant>.json, <template>-<part>.json).
    for (const f of tplFiles) {
      const id = f.slice(0, -5);
      if (id === t || id.startsWith(`${t}.`) || id.startsWith(`${t}-`)) parts.push(['template', f, fs.readFileSync(path.join(tplDir, f), 'utf8')]);
    }
  }
  // Templates the spec seams render without owning them (config: templates).
  for (const t of decl.templates || []) {
    for (const f of tplFiles) if (f.slice(0, -5) === t) parts.push(['shared-template', f, fs.readFileSync(path.join(tplDir, f), 'utf8')]);
  }
  for (const k of decl.contractSections || []) parts.push(['contract', k, contract[k] === undefined ? null : contract[k]]);
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

if (require.main === module) {
  try { process.stdout.write(specInputsDigest(process.argv[2] || path.join(__dirname, '..', '..', '..'))); } catch { process.exit(0); }
}

module.exports = { specInputsDigest };
