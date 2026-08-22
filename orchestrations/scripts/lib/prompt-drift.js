#!/usr/bin/env node
/**
 * PROMPT DRIFT — a project prompt that lags its template loses evidence, in silence.
 *
 * The layer rule is that the TEMPLATE is the immutable generic source and the PROJECT prompt is
 * the only thing ever rendered (see prompt-library.js). Nothing enforced that the project copy
 * still declares what its template declares. So the template gains a placeholder, the minted
 * copy does not, the caller keeps supplying the value, and prompt-library drops it.
 *
 * Live 20260821T212250Z: prior-reviews.py built the reviewer's history correctly and it was
 * supplied as __PRIOR_REVIEW__. metrolinx/team-lead-review.json declares no such placeholder, so
 * it went nowhere. All three review cycles ran with no memory of each other, and the approval
 * missed a regression the earlier cycle had caught. The run log mentions prior review 0 times.
 *
 * That is one of ELEVEN drifted prompts. The others silently drop the typecheck command, the
 * test command, the test-file conventions, the config surface and the CVE rule prefix.
 *
 * WHY PATCH RATHER THAN RE-MINT: minting is a paid agent run, and the drifted content is
 * TEMPLATE text — generic by construction, since a template may contain no project fact. Porting
 * it is deterministic and costs nothing. Re-minting would also regenerate text that is not
 * drifted, discarding whatever self-heal has corrected in the project layer.
 *
 *   node prompt-drift.js report            — list every drifted project prompt (exit 1 if any)
 *   node prompt-drift.js patch [--dry-run] — port the missing blocks from each template
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { placeholdersIn } = require('./engine-prompt.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATES = path.join(ROOT, 'orchestrations', 'prompts', 'templates');
const PROJECTS = path.join(ROOT, 'orchestrations', 'projects');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Every (project, prompt) pair that has a template to compare against. */
function pairs() {
  if (!fs.existsSync(PROJECTS)) return [];
  const out = [];
  for (const proj of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, proj, 'prompts');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const tf = path.join(TEMPLATES, file);
      if (fs.existsSync(tf)) out.push({ proj, id: file.replace(/\.json$/, ''), tf, pf: path.join(dir, file) });
    }
  }
  return out;
}

/**
 * What the project copy is missing. Compared on the BODY, not on the declared list: a prompt
 * that lists a placeholder it never uses is a different defect, and render() already rejects it.
 */
function driftFor({ tf, pf }) {
  const t = readJson(tf);
  const p = readJson(pf);
  const tBody = typeof t.body === 'string' ? t.body : '';
  const pBody = typeof p.body === 'string' ? p.body : '';
  const inProject = new Set(placeholdersIn(pBody));
  return [...placeholdersIn(tBody)].filter((x) => !inProject.has(x));
}

/**
 * Port the template blocks carrying `missing` into the project body.
 *
 * Position is not cosmetic — a rule that lands after the output contract reads as an afterthought
 * to a model. So each block is inserted after the nearest PRECEDING template block that the
 * project body still contains verbatim, which keeps it where the template's author put it.
 * A block with no such anchor is appended and REPORTED, never dropped silently.
 */
function patchBody(tBody, pBody, missing) {
  const tBlocks = tBody.split('\n\n');
  let out = pBody;
  const unanchored = [];
  for (const ph of missing) {
    const idx = tBlocks.findIndex((b) => b.includes(ph));
    if (idx < 0) continue;
    const block = tBlocks[idx];
    if (out.includes(block)) continue;            // already there under a different split
    let anchored = false;
    for (let j = idx - 1; j >= 0; j--) {
      const anchor = tBlocks[j];
      if (anchor.trim() && out.includes(anchor)) {
        out = out.replace(anchor, `${anchor}\n\n${block}`);
        anchored = true;
        break;
      }
    }
    if (!anchored) { out = `${out}\n\n${block}`; unanchored.push(ph); }
  }
  return { body: out, unanchored };
}

/**
 * Blocks of TEMPLATE prose the project copy does not carry at all.
 *
 * WHOLLY ABSENT, not merely different. A project prompt is a specialisation — it is supposed to
 * differ, and a rule the project reworded is not a rule it lost. Comparing line by line would
 * report every legitimately rephrased sentence and porting on that basis would duplicate them.
 * So a block counts as missing only when NONE of its substantial lines appears in the project
 * body, which is the difference between "this was changed" and "this was dropped".
 *
 * This is the drift that cost an approval: the reviewer template says a finding must carry
 * evidence, and that a blocker raised on an earlier iteration still stands unless the code has
 * changed. Neither sentence was in the copy that ran, and the placeholder check could not see it
 * because no placeholder was involved.
 */
function proseDriftFor({ tf, pf }) {
  const t = readJson(tf);
  const p = readJson(pf);
  const tBody = typeof t.body === 'string' ? t.body : '';
  const pBody = typeof p.body === 'string' ? p.body : '';
  if (!tBody || !pBody) return [];                 // multi-part prompts are compared per part
  const present = new Set(pBody.split('\n').map((l) => l.trim()).filter(Boolean));
  const substantial = (l) => l.trim().length > 40;
  return tBody.split('\n\n').filter((block) => {
    const lines = block.split('\n').filter(substantial);
    if (!lines.length) return false;
    return !lines.some((l) => present.has(l.trim()));
  });
}

/** Insert a block where its author put it: after the nearest preceding block still present. */
function insertBlock(tBody, pBody, block) {
  const tBlocks = tBody.split('\n\n');
  const idx = tBlocks.indexOf(block);
  for (let j = idx - 1; j >= 0; j--) {
    const anchorBlock = tBlocks[j];
    if (anchorBlock.trim() && pBody.includes(anchorBlock)) {
      return pBody.replace(anchorBlock, `${anchorBlock}\n\n${block}`);
    }
  }
  return `${pBody}\n\n${block}`;                    // no anchor: appended, and the caller reports it
}

function main() {
  const cmd = process.argv[2] || 'report';
  const dry = process.argv.includes('--dry-run');
  const rows = [];
  for (const pair of pairs()) {
    const missing = driftFor(pair);
    if (missing.length) rows.push({ ...pair, missing });
  }
  if (cmd === 'report') {
    rows.forEach((r) => console.log(`${r.proj}/${r.id}: ${r.missing.join(' ')}`));
    console.log(`${rows.length} drifted project prompt(s)`);
    process.exit(rows.length ? 1 : 0);
  }
  if (cmd === 'prose' || cmd === 'patch-prose') {
    let n = 0;
    let unanchored = 0;
    for (const pair of pairs()) {
      const blocks = proseDriftFor(pair);
      if (!blocks.length) continue;
      const rel = `${path.basename(path.dirname(path.dirname(pair.pf)))}/${path.basename(pair.pf, '.json')}`;
      if (cmd === 'prose') {
        console.log(`${rel}: ${blocks.length} block(s) the template states and this copy does not`);
        n += blocks.length;
        continue;
      }
      const t = readJson(pair.tf);
      const p = readJson(pair.pf);
      let body = p.body;
      for (const b of blocks) {
        const before = body;
        body = insertBlock(t.body, body, b);
        if (body === `${before}\n\n${b}`) unanchored++;
      }
      // Verify before writing, exactly as the placeholder patch does: a copy that gained a
      // placeholder it does not declare fails render, mid-run, at whichever seam needed it.
      const used = new Set(placeholdersIn(body));
      const declared = [...new Set([...(p.placeholders || []), ...used])].sort();
      const orphan = declared.filter((x) => !used.has(x));
      if (orphan.length) {
        console.error(`REFUSED ${rel}: would declare unused ${orphan.join(', ')}`);
        process.exitCode = 1;
        continue;
      }
      fs.writeFileSync(pair.pf, `${JSON.stringify({ ...p, placeholders: declared, body }, null, 2)}\n`);
      console.log(`patched ${rel}: +${blocks.length} block(s)`);
      n += blocks.length;
    }
    if (unanchored) console.error(`  ${unanchored} block(s) appended with no anchor — check placement`);
    if (cmd === 'prose') {
      console.log(`${n} block(s) of template prose missing from project copies`);
      process.exit(n ? 1 : 0);
    }
    return;
  }
  if (cmd !== 'patch') { console.error(`unknown command '${cmd}' (report|patch|prose|patch-prose)`); process.exit(2); }

  for (const r of rows) {
    const t = readJson(r.tf);
    const p = readJson(r.pf);
    const { body, unanchored } = patchBody(t.body, p.body, r.missing);
    const declared = [...new Set([...(p.placeholders || []), ...r.missing])].sort();
    // Verify BEFORE writing: a patch that leaves the prompt still missing something, or that
    // declares what it does not use, would be refused at render — at which point the seam is
    // down mid-run instead of here.
    const nowPresent = new Set(placeholdersIn(body));
    const stillMissing = r.missing.filter((x) => !nowPresent.has(x));
    const orphan = declared.filter((x) => !nowPresent.has(x));
    if (stillMissing.length || orphan.length) {
      console.error(`REFUSED ${r.proj}/${r.id}: stillMissing=${stillMissing} orphanDeclared=${orphan}`);
      process.exitCode = 1;
      continue;
    }
    if (unanchored.length) console.error(`  ${r.proj}/${r.id}: appended (no anchor): ${unanchored.join(' ')}`);
    if (!dry) fs.writeFileSync(r.pf, `${JSON.stringify({ ...p, placeholders: declared, body }, null, 2)}\n`);
    console.log(`${dry ? 'would patch' : 'patched'} ${r.proj}/${r.id}: +${r.missing.join(' ')}`);
  }
}

if (require.main === module) main();
module.exports = { pairs, driftFor, patchBody, proseDriftFor, insertBlock };
