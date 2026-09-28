'use strict';
/**
 * AN ESTIMATION MANIFEST INFORMS THE BROWNFIELD AGENTS. Operator, 2026-09-28: "ingest jira - then
 * inform the pipeline of this artefact to augment the downstream agents. do not break the pipeline
 * by doing so!! … it can be a new env var."
 *
 * EPAM_ESTIMATION_MANIFEST names a file or a directory holding the estimation application's output:
 * its per-story page (ai-estimate-story-<KEY>.html — a code assessment, the acceptance criteria
 * against the implementation, attachment findings, the recommended split) and/or its manifest keyed
 * by ticket (the engine's JSON). What each looks like is declared in config/estimation-manifest.json;
 * nothing here knows a heading or a field name.
 *
 *   extract <manifest> <KEY> <out.json>   the ticket's record, persisted. exit 0 written;
 *                                         3 = the manifest holds nothing for this ticket (said on
 *                                         stderr, nothing written); 1 = the manifest is unreadable.
 *   for-story <story-id> <prd> <consumer> the block a consumer's prompt receives, on stdout: the
 *                                         story's ticket (a split child resolves through
 *                                         specification.createdFrom) → $EPAM_ESTIMATION_DIR/<KEY>.json
 *                                         (exported by the ingest step for this run, and only it)
 *                                         → framed by the consumer's part of the engine template
 *                                         `estimation-assessment`. No record → empty, exit 0: the
 *                                         placeholder is declared mayBeEmpty, and a run without a
 *                                         manifest renders exactly as it did before this existed.
 *
 * The record is evidence for the agents, never an instruction to the pipeline: it does not touch
 * the PRD, and it cannot add or remove work.
 */
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', '..', 'config', 'estimation-manifest.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', rarr: '→', times: '×', plusmn: '±', hellip: '…', middot: '·' };
function unescape(t) {
  return String(t)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

/** HTML fragment → readable text: a table row per line with its cells separated, headings kept. */
function htmlToText(fragment) {
  let s = String(fragment)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n${'#'.repeat(Math.min(Number(l) + 1, 6))} ${t}\n`)
    .replace(/<\/(td|th)>\s*/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|section|table|thead|tbody|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  s = unescape(s);
  return s.split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter((l) => l && l !== '|')
    .join('\n');
}

/** Every heading of the page with its level and where it starts and its text ends. */
function headings(html) {
  const out = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push({ level: Number(m[1]), text: htmlToText(m[2]).replace(/\n/g, ' '), start: m.index, after: re.lastIndex });
  }
  return out;
}

/** The declared sections of one page: heading-matched, each up to the next heading at its level or above. */
function extractHtml(html, cfg) {
  const hs = headings(html);
  const sections = [];
  const taken = new Set();
  for (const want of (cfg.sections || [])) {
    const rx = new RegExp(want.heading, 'i');
    hs.forEach((h, i) => {
      if (taken.has(i) || !rx.test(h.text)) return;
      const next = hs.slice(i + 1).find((n) => n.level <= h.level);
      const body = htmlToText(html.slice(h.after, next ? next.start : html.length));
      if (!body) return;
      taken.add(i);
      sections.push({ label: want.label, heading: h.text, text: body });
    });
  }
  if (cfg.summaryBox && cfg.summaryBox.kicker) {
    const at = html.indexOf(cfg.summaryBox.kicker);
    if (at >= 0) {
      const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html.slice(at));
      if (p) sections.unshift({ label: cfg.summaryBox.label, heading: cfg.summaryBox.kicker, text: htmlToText(p[1]) });
    }
  }
  return sections;
}

/** The ticket's entries in a manifest path: its page and/or its entry in any JSON manifest there. */
function findEntries(manifest, key) {
  const cfg = readConfig();
  const st = fs.statSync(manifest);
  const files = st.isDirectory() ? fs.readdirSync(manifest).map((f) => path.join(manifest, f)) : [manifest];
  const pageName = cfg.html.fileName.replace('{KEY}', key);
  const found = { page: null, json: [] };
  for (const f of files) {
    const base = path.basename(f);
    if (/\.html?$/i.test(base)) {
      if (base === pageName || (!st.isDirectory() && fs.readFileSync(f, 'utf8').includes(key))) found.page = f;
    } else if (/\.json$/i.test(base)) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
        if (!st.isDirectory()) throw new Error(`${f} is not valid JSON: ${e.message}`);
        continue; // a directory may hold other JSON; only a named file must parse
      }
      if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc[key] && typeof doc[key] === 'object') {
        found.json.push({ file: f, entry: doc[key] });
      }
    }
  }
  return found;
}

function extract(manifest, key) {
  const cfg = readConfig();
  const found = findEntries(manifest, key);
  const record = { key, manifest: path.resolve(manifest), sources: [], sections: [], fields: {} };
  if (found.page) {
    const sections = extractHtml(fs.readFileSync(found.page, 'utf8'), cfg.html);
    record.sources.push(found.page);
    record.sections.push(...sections);
    if (!sections.length) record.warnings = [`${path.basename(found.page)}: none of the declared sections was found`];
  }
  for (const j of found.json) {
    record.sources.push(j.file);
    const ordered = {};
    for (const f of (cfg.json.fields || [])) if (j.entry[f] !== undefined) ordered[f] = j.entry[f];
    for (const [k, v] of Object.entries(j.entry)) if (!(k in ordered)) ordered[k] = v;
    // PER SOURCE, NEVER MERGED: two manifests can size the same ticket differently (pi12-ai-estimates
    // and pi12-engine-estimates disagree on AMSD-2974's anchor and basis), and a merge would let the
    // file listed last win silently.
    record.fields[path.basename(j.file)] = ordered;
  }
  return record.sources.length ? record : null;
}

/** The record as prompt text: sizing fields first, then each section under its label. */
function recordText(record) {
  const lines = [`Source: ${record.sources.map((s) => path.basename(s)).join(', ')} (ticket ${record.key})`];
  for (const [source, fields] of Object.entries(record.fields || {})) {
    lines.push('', `### Sizing (${source})`);
    for (const [k, v] of Object.entries(fields)) lines.push(`- ${k}: ${Array.isArray(v) ? v.join('; ') : (v && typeof v === 'object' ? JSON.stringify(v) : v)}`);
  }
  for (const s of record.sections || []) lines.push('', `### ${s.label}`, s.text);
  return lines.join('\n');
}

/** The ticket a story belongs to: its own key, or its split parent's, up the createdFrom chain. */
function ticketFor(storyId, prd) {
  const byId = new Map((prd.stories || []).map((s) => [s.id, s]));
  let s = byId.get(storyId);
  for (let hops = 0; s && hops < 20; hops += 1) {
    if (s.jiraKey) return s.jiraKey;
    const parent = s.specification && s.specification.createdFrom;
    if (!parent || parent === s.id) break;
    // A parent the PRD in hand does not hold (a caller with only the story) is the ticket itself.
    if (!byId.has(parent)) return parent;
    s = byId.get(parent);
  }
  return byId.has(storyId) ? null : storyId;
}

/**
 * Where this run's records live: ONLY the directory the ingest step exported for THIS run. No
 * fallback to $LOG_DIR/estimation — a resume keeps its log directory, and a fallback would render a
 * previous run's assessment into a run whose manifest was since removed. No export, no assessment.
 */
function recordDir(env) {
  const e = env || process.env;
  return e.EPAM_ESTIMATION_DIR || '';
}

/**
 * @param prd  the PRD as a path or as the parsed object (a JS caller already holds it)
 */
function forStory(storyId, prd, consumer, env) {
  const dir = recordDir(env);
  if (!dir) return '';
  let doc = { stories: [] };
  if (prd && typeof prd === 'object') doc = prd;
  else if (prd) { try { doc = JSON.parse(fs.readFileSync(prd, 'utf8')); } catch { /* no PRD: the id is the ticket */ } }
  const key = ticketFor(storyId, doc) || storyId;
  const file = path.join(dir, `${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  if (!fs.existsSync(file)) return '';
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('../engine-prompt.js');
  return renderEngineTemplate('estimation-assessment', { __TICKET__: record.key, __ASSESSMENT__: recordText(record) }, consumer);
}

module.exports = { extract, extractHtml, htmlToText, recordText, ticketFor, forStory, findEntries, recordDir };

if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    if (cmd === 'extract') {
      const rec = extract(a, b);
      if (!rec) { process.stderr.write(`[estimation-manifest] ${a} holds nothing for ${b}\n`); process.exit(3); }
      fs.mkdirSync(path.dirname(c), { recursive: true });
      fs.writeFileSync(c, `${JSON.stringify(rec, null, 1)}\n`);
      for (const w of rec.warnings || []) process.stderr.write(`[estimation-manifest] WARNING ${b}: ${w}\n`);
      process.stdout.write(`${b}: ${rec.sections.length} section(s), ${Object.keys(rec.fields).length} sized manifest(s) from ${rec.sources.map((s) => path.basename(s)).join(', ')}\n`);
    } else if (cmd === 'for-story') {
      process.stdout.write(forStory(a, b, c));
    } else {
      process.stderr.write('usage: estimation-manifest.js extract <manifest> <KEY> <out.json> | for-story <story-id> <prd> <consumer>\n');
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`[estimation-manifest] ${(err && err.message) || err}\n`);
    process.exit(1);
  }
}
