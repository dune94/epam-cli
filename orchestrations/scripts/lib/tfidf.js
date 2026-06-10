#!/usr/bin/env node
/**
 * TF-IDF keyword retrieval for CPA knowledge base indexing.
 *
 * Usage:
 *   node tfidf.js --kb-dir <path> --query <text> [--top <n>] [--chunk-size <lines>] [--extra-docs <csv>]
 *
 * Reads all .md and .txt files from --kb-dir, builds a TF-IDF index,
 * scores against --query, and returns top-K chunks as JSON to stdout.
 *
 * Output: JSON array of {source, score, chunk} to stdout.
 * Errors: to stderr only.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Arg parsing (CLI mode only) ────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (flag, def = '') => {
  const i = argv.indexOf(flag);
  return (i !== -1 && argv[i + 1] !== undefined) ? argv[i + 1] : def;
};
const hasFlag = (flag) => argv.includes(flag);

// These are read from args when run as CLI; tests use the exported functions directly.
const KB_DIR     = getArg('--kb-dir');
const QUERY      = getArg('--query');
const TOP_K      = parseInt(getArg('--top', '5'), 10);
const CHUNK_SIZE = parseInt(getArg('--chunk-size', '25'), 10);
const EXTRA_DOCS = getArg('--extra-docs', ''); // comma-separated file paths

// ── Stopwords ──────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','have','has','had','do',
  'does','did','will','would','could','should','may','might','can','this',
  'that','these','those','it','its','as','up','if','not','no','so','than',
  'then','when','where','how','what','which','who','all','any','each',
  'every','both','more','most','other','some','such','into','through',
  'during','before','after','above','below','between','out','off','over',
  'under','again','further','there','here','also','just','very','about',
  'using','used','use','new','add','added','run','running','file','files',
  'true','false','null','undefined','return','function','const','let','var',
]);

// ── Text processing ────────────────────────────────────────────────────────

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')   // strip code fences
    .replace(/`[^`]*`/g, ' ')          // strip inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → text
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/[\s\-_/\.]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function computeTF(tokens) {
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const total = tokens.length || 1;
  const tf = {};
  for (const [t, n] of Object.entries(freq)) tf[t] = n / total;
  return tf;
}

// ── Corpus loading ─────────────────────────────────────────────────────────

function loadFile(filePath, sourceName) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { source: sourceName || path.basename(filePath), content, lines: content.split('\n') };
  } catch {
    return null;
  }
}

function loadCorpus() {
  const docs = [];

  // KB directory markdown files
  if (KB_DIR && fs.existsSync(KB_DIR)) {
    const entries = fs.readdirSync(KB_DIR)
      .filter(f => /\.(md|txt)$/.test(f))
      .sort();
    for (const f of entries) {
      const doc = loadFile(path.join(KB_DIR, f));
      if (doc) docs.push(doc);
    }
  }

  // Extra docs (AGENTS.md, KB.md, INSTRUCTIONS.md, estimation.md etc.)
  if (EXTRA_DOCS) {
    for (const raw of EXTRA_DOCS.split(',')) {
      const f = raw.trim();
      if (f) {
        const doc = loadFile(f);
        if (doc) docs.push(doc);
      }
    }
  }

  return docs;
}

// ── TF-IDF index ───────────────────────────────────────────────────────────

function buildIDF(docs) {
  const docFreq = {};
  for (const doc of docs) {
    for (const t of new Set(tokenize(doc.content))) {
      docFreq[t] = (docFreq[t] || 0) + 1;
    }
  }
  const N = Math.max(docs.length, 1);
  const idf = {};
  for (const [t, df] of Object.entries(docFreq)) {
    idf[t] = Math.log((N + 1) / (df + 1)) + 1; // smoothed IDF
  }
  return idf;
}

function scoreDoc(doc, queryTerms, idf) {
  const tf = computeTF(tokenize(doc.content));
  let score = 0;
  for (const qt of queryTerms) {
    score += (tf[qt] || 0) * (idf[qt] || 0);
  }
  return score;
}

// ── Chunk extraction ───────────────────────────────────────────────────────

function extractChunk(doc, queryTerms) {
  const lines = doc.lines;
  if (lines.length === 0) return '';

  // Score each line by query term hits (weighted by position — headers score higher)
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineTerms = new Set(tokenize(lines[i]));
    let hits = 0;
    for (const qt of queryTerms) {
      if (lineTerms.has(qt)) hits++;
    }
    // Boost heading lines
    const headingBoost = /^#{1,3}\s/.test(lines[i]) ? 1.5 : 1.0;
    const lineScore = hits * headingBoost;
    if (lineScore > bestScore) {
      bestScore = lineScore;
      bestIdx = i;
    }
  }

  // Find nearest heading before bestIdx for context
  let start = bestIdx;
  for (let i = bestIdx - 1; i >= 0; i--) {
    if (/^#{1,3}\s/.test(lines[i])) { start = i; break; }
    if (bestIdx - i > 5) break;
  }
  start = Math.max(0, start);
  const end = Math.min(lines.length, start + CHUNK_SIZE);

  return lines.slice(start, end).join('\n').trim();
}

// ── Main ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (!QUERY) {
    process.stderr.write('Usage: node tfidf.js --kb-dir <path> --query <text> [--top <n>] [--chunk-size <lines>] [--extra-docs <csv>]\n');
    process.exit(1);
  }

  const corpus = loadCorpus();

  if (corpus.length === 0) {
    process.stdout.write('[]\n');
    process.exit(0);
  }

  const idf        = buildIDF(corpus);
  const queryTerms = tokenize(QUERY);

  if (queryTerms.length === 0) {
    // No useful query terms — return first TOP_K docs (truncated)
    const fallback = corpus.slice(0, TOP_K).map(doc => ({
      source: doc.source,
      score: 0,
      chunk: doc.lines.slice(0, CHUNK_SIZE).join('\n').trim(),
    }));
    process.stdout.write(JSON.stringify(fallback) + '\n');
    process.exit(0);
  }

  const scored = corpus
    .map(doc => ({ source: doc.source, score: scoreDoc(doc, queryTerms, idf), doc }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const results = scored.map(({ source, score, doc }) => ({
    source,
    score: Math.round(score * 10000) / 10000,
    chunk: extractChunk(doc, queryTerms),
  }));

  process.stdout.write(JSON.stringify(results) + '\n');
}

module.exports = { tokenize, computeTF, buildIDF, scoreDoc, extractChunk };
