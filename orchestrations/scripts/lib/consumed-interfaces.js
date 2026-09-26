'use strict';
/**
 * A CONSUMED FILE NAMES A STORY THAT HOLDS IT.
 *
 * The spec pass lets an agent say "this story consumes file X from story Y" (consumesInterfaces):
 * X leaves the story's files and Y becomes a dependency. Nothing checked Y. Live, regintel run
 * 20260926T125158Z: REGI-006 consumed tests/test_injection.py "from REGI-005" — a story that had been
 * split into children that do not declare the file — and was left with no files at all; REGI-014
 * consumed dial/client.py "from REGI-014a", a story that does not exist, for a file REGI-014 itself
 * owns, and waited on it forever. The core phase aborted on both.
 *
 * One rule, applied wherever the PRD is about to be acted on (the end of the spec pass, and every
 * pre-phase remediation — which is what a resume runs):
 *   - a story cannot consume a file it owns (ownsSharedFiles);
 *   - an owner that was split is followed to the child that declares the file;
 *   - a claim stands only when that owner is a story in the PRD, is not the claimant, and declares
 *     the file (technicalNotes.files or ownsSharedFiles);
 *   - a claim that does not stand is moved to consumesInterfacesRejected with its reason; the file
 *     returns to the story when the spec pass took it (specification.consumedFilesRemoved) or the
 *     authored story declared it; a dependency on a story that is not in the PRD is dropped.
 * Completed and deprecated stories are history and are not rewritten.
 */
const fs = require('fs');

const norm = (f) => String(f || '').replace(/^\.\//, '');
const filesOf = (s) => [
  ...((s && s.technicalNotes && Array.isArray(s.technicalNotes.files)) ? s.technicalNotes.files : []),
  ...((s && Array.isArray(s.ownsSharedFiles)) ? s.ownsSharedFiles : []),
].map(norm);
const isHistory = (s) => s.status === 'deprecated' || s.status === 'completed';

/** The owner a claim names, followed through splits to the (first) descendant declaring the file. */
function resolveOwner(prd, ownerId, file) {
  const stories = prd.stories || [];
  const owner = stories.find((s) => s.id === ownerId);
  if (!owner) return { owner: null, why: `${ownerId || '(none)'} is not a story in the PRD` };
  if (owner.status !== 'deprecated') {
    return filesOf(owner).includes(file) ? { owner } : { owner: null, why: `${owner.id} does not declare ${file}` };
  }
  const queue = stories.filter((c) => c.specification && c.specification.createdFrom === owner.id);
  while (queue.length) {
    const c = queue.shift();
    if (c.status !== 'deprecated' && filesOf(c).includes(file)) return { owner: c };
    queue.push(...stories.filter((g) => g.specification && g.specification.createdFrom === c.id));
  }
  return { owner: null, why: `${owner.id} was split and no child of it declares ${file}` };
}

/**
 * Reconcile every live story's consume claims against the PRD. Mutates `prd`; returns the changes.
 * opts.canonical: the authored PRD (its story files may be given back); opts.log: line sink.
 */
function reconcileConsumedInterfaces(prd, opts = {}) {
  const changes = [];
  const canonicalFiles = new Map(((opts.canonical && opts.canonical.stories) || [])
    .map((s) => [s.id, filesOf(s)]));
  const ids = new Set((prd.stories || []).map((s) => s.id));
  for (const s of prd.stories || []) {
    if (!Array.isArray(s.consumesInterfaces) || !s.consumesInterfaces.length || isHistory(s)) continue;
    const kept = [];
    for (const c of s.consumesInterfaces) {
      const file = norm(c && c.file);
      if (!file) { kept.push(c); continue; }
      let why = null;
      let owner = null;
      if ((Array.isArray(s.ownsSharedFiles) ? s.ownsSharedFiles.map(norm) : []).includes(file)) {
        why = `${s.id} owns ${file} itself`;
      } else {
        ({ owner, why } = resolveOwner(prd, c.ownerStoryId, file));
        if (owner && owner.id === s.id) { owner = null; why = `${s.id} names itself as the owner of ${file}`; }
      }
      if (owner) {
        if (owner.id !== c.ownerStoryId) {
          const deps = (s.dependencies || []).filter((d) => d !== c.ownerStoryId);
          if (!deps.includes(owner.id)) deps.push(owner.id);
          s.dependencies = deps;
          changes.push({ story: s.id, file, action: 'redirected', from: c.ownerStoryId, to: owner.id });
          kept.push({ ...c, ownerStoryId: owner.id });
        } else {
          kept.push(c);
        }
        continue;
      }
      // Rejected: record it, give the file back where the story held it, drop an impossible edge.
      s.consumesInterfacesRejected = [...(s.consumesInterfacesRejected || []), { ...c, reason: why }];
      const removed = ((s.specification && s.specification.consumedFilesRemoved) || []).map(norm);
      const authored = canonicalFiles.get(s.id) || [];
      const restore = removed.includes(file) || authored.includes(file);
      if (restore) {
        s.technicalNotes = s.technicalNotes || {};
        const cur = Array.isArray(s.technicalNotes.files) ? s.technicalNotes.files : [];
        if (!cur.map(norm).includes(file)) s.technicalNotes.files = [...cur, file];
      }
      if (c.ownerStoryId && !ids.has(c.ownerStoryId) && Array.isArray(s.dependencies)) {
        s.dependencies = s.dependencies.filter((d) => d !== c.ownerStoryId);
      }
      changes.push({ story: s.id, file, action: 'rejected', reason: why, restored: restore });
    }
    if (kept.length) s.consumesInterfaces = kept; else delete s.consumesInterfaces;
  }
  for (const ch of changes) {
    const line = ch.action === 'redirected'
      ? `consumed-interfaces: ${ch.story} consumes ${ch.file} from ${ch.to} (named ${ch.from}, which was split)`
      : `consumed-interfaces: ${ch.story} claim on ${ch.file} REJECTED — ${ch.reason}${ch.restored ? '; the file is back in its scope' : ''}`;
    (opts.log || console.log)(line);
  }
  return changes;
}

module.exports = { reconcileConsumedInterfaces };

// CLI: node consumed-interfaces.js <prd.json> [canonical.json] — rewrites the PRD atomically when
// anything changed. Run by prd-remediate.sh before any other remediation step.
if (require.main === module) {
  const [prdFile, canonicalFile] = process.argv.slice(2);
  if (!prdFile) { console.error('usage: consumed-interfaces.js <prd.json> [canonical.json]'); process.exit(2); }
  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  let canonical = null;
  if (canonicalFile && fs.existsSync(canonicalFile)) {
    try { canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8')); } catch { canonical = null; }
  }
  const changes = reconcileConsumedInterfaces(prd, { canonical });
  if (changes.length) {
    const tmp = `${prdFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prd, null, 2) + '\n');
    fs.renameSync(tmp, prdFile);
  }
}
