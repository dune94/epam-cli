#!/usr/bin/env node
/**
 * semantic-search.js — OpenAI-embedding-based retrieval for CPA.
 *
 * Drop-in replacement for tfidf.js.  Same CLI interface, same JSON output.
 * Uses cosine similarity over text-embedding-3-small vectors instead of
 * TF-IDF keyword matching.
 *
 * On first run, embeds the entire corpus and caches vectors to
 *   <project-root>/.epam/kb-embeddings.json
 * Subsequent runs skip re-embedding unless a source file has changed.
 *
 * Requires EPAM_API_KEY_OPENAI (or OPENAI_API_KEY) to be set.
 * Falls back to empty results (not an error) if the key is absent —
 * contextualize-stories.sh falls back to tfidf.js in that case.
 *
 * Usage (identical to tfidf.js):
 *   node semantic-search.js \
 *       --kb-dir <path> \
 *       --query  <text> \
 *      [--top <n>]             default: 5
 *      [--chunk-size <lines>]  default: 25
 *      [--extra-docs <csv>]
 *      [--vector-store <path>] default: <project-root>/.epam/kb-embeddings.json
 *      [--assets <path>]       default: <project-root>/.epam/assets.json
 *
 * Output: JSON array of {source, score, chunk} to stdout.
 * Errors: stderr only.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Arg parsing ────────────────────────────────────────────────────────────

const argv   = process.argv.slice(2);
const getArg = (flag, def = '') => {
  const i = argv.indexOf(flag);
  return (i !== -1 && argv[i + 1] !== undefined) ? argv[i + 1] : def;
};

const KB_DIR       = getArg('--kb-dir');
const QUERY        = getArg('--query');
const TOP_K        = parseInt(getArg('--top', '5'), 10);
const CHUNK_SIZE   = parseInt(getArg('--chunk-size', '25'), 10);
const EXTRA_DOCS   = getArg('--extra-docs', '');

// Derive project root from this script's location: lib/ → scripts/ → orchestrations/ → project/
const SCRIPT_DIR   = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');
const VECTOR_STORE = getArg('--vector-store', path.join(PROJECT_ROOT, '.epam', 'kb-embeddings.json'));
const ASSETS_FILE  = getArg('--assets',       path.join(PROJECT_ROOT, '.epam', 'assets.json'));

const OPENAI_API_KEY = process.env.EPAM_API_KEY_OPENAI || process.env.OPENAI_API_KEY || '';
const EMBED_MODEL    = 'text-embedding-3-small';

if (!QUERY) {
  process.stderr.write('Usage: node semantic-search.js --kb-dir <path> --query <text> [options]\n');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  // No key — caller falls back to tfidf.js
  process.stdout.write('[]\n');
  process.exit(0);
}

// ── Text chunking ──────────────────────────────────────────────────────────

function chunkLines(lines, chunkSize) {
  const chunks = [];
  // Split at headings first, then hard-cap at chunkSize lines
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    const atHeading = i < lines.length && /^#{1,3}\s/.test(lines[i]);
    const atCap     = (i - start) >= chunkSize;
    if ((atHeading || atCap || i === lines.length) && i > start) {
      chunks.push(lines.slice(start, i).join('\n').trim());
      start = i;
    }
  }
  return chunks.filter(c => c.length > 20);
}

function loadCorpus() {
  const docs = [];

  if (KB_DIR && fs.existsSync(KB_DIR)) {
    for (const f of fs.readdirSync(KB_DIR).filter(f => /\.(md|txt)$/.test(f)).sort()) {
      const fp = path.join(KB_DIR, f);
      try {
        const lines = fs.readFileSync(fp, 'utf8').split('\n');
        for (const chunk of chunkLines(lines, CHUNK_SIZE)) {
          docs.push({ source: f, chunk, mtime: fs.statSync(fp).mtimeMs });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  if (EXTRA_DOCS) {
    for (const raw of EXTRA_DOCS.split(',')) {
      const fp = raw.trim();
      if (!fp || !fs.existsSync(fp)) continue;
      try {
        const lines = fs.readFileSync(fp, 'utf8').split('\n');
        const name  = path.basename(fp);
        for (const chunk of chunkLines(lines, CHUNK_SIZE)) {
          docs.push({ source: name, chunk, mtime: fs.statSync(fp).mtimeMs });
        }
      } catch { /* skip */ }
    }
  }

  // assets.json — embed each asset's title + description + tags as a chunk
  if (fs.existsSync(ASSETS_FILE)) {
    try {
      const assets = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf8'));
      const mtime  = fs.statSync(ASSETS_FILE).mtimeMs;
      for (const a of Array.isArray(assets) ? assets : []) {
        const tags  = Array.isArray(a.tags) ? a.tags.join(', ') : '';
        const chunk = [a.title, a.description, tags, a.category].filter(Boolean).join('\n');
        if (chunk.length > 10) {
          docs.push({ source: `assets:${a.id || a.title}`, chunk, mtime });
        }
      }
    } catch { /* skip malformed assets.json */ }
  }

  return docs;
}

// ── OpenAI Embeddings API ──────────────────────────────────────────────────

function embedBatch(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: texts, encoding_format: 'float' });
    const req  = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/embeddings',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          resolve(parsed.data.map(d => d.embedding));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Embed in batches of 100 (OpenAI limit is 2048 inputs, but smaller = safer)
async function embedAll(texts) {
  const BATCH = 100;
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vecs  = await embedBatch(batch);
    vectors.push(...vecs);
  }
  return vectors;
}

// ── Cosine similarity ──────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Vector store (JSON file cache) ────────────────────────────────────────

function loadStore() {
  try {
    if (fs.existsSync(VECTOR_STORE)) {
      return JSON.parse(fs.readFileSync(VECTOR_STORE, 'utf8'));
    }
  } catch { /* corrupt store — rebuild */ }
  return null;
}

function storeIsStale(store, corpus) {
  if (!store || store.model !== EMBED_MODEL) return true;
  if (store.entries.length !== corpus.length)  return true;
  // Stale if any source file is newer than the store's build time
  const builtAt = store.built_at_ms || 0;
  return corpus.some(d => d.mtime > builtAt);
}

function saveStore(store) {
  try {
    const dir = path.dirname(VECTOR_STORE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(VECTOR_STORE, JSON.stringify(store), 'utf8');
  } catch (e) {
    process.stderr.write(`semantic-search: could not save vector store: ${e.message}\n`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const corpus = loadCorpus();
    if (corpus.length === 0) {
      process.stdout.write('[]\n');
      process.exit(0);
    }

    // Load or rebuild vector store
    let store = loadStore();
    if (storeIsStale(store, corpus)) {
      process.stderr.write(`semantic-search: (re)building vector store for ${corpus.length} chunks...\n`);
      const vectors = await embedAll(corpus.map(d => d.chunk));
      store = {
        model:        EMBED_MODEL,
        built_at_ms:  Date.now(),
        entries:      corpus.map((d, i) => ({ source: d.source, chunk: d.chunk, vector: vectors[i] })),
      };
      saveStore(store);
      process.stderr.write(`semantic-search: vector store saved to ${VECTOR_STORE}\n`);
    }

    // Embed query and rank
    const [queryVec] = await embedAll([QUERY]);
    const scored = store.entries
      .map(e => ({ source: e.source, chunk: e.chunk, score: cosine(queryVec, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(e => ({ source: e.source, score: Math.round(e.score * 10000) / 10000, chunk: e.chunk }));

    process.stdout.write(JSON.stringify(scored) + '\n');
    process.exit(0);

  } catch (e) {
    process.stderr.write(`semantic-search: error: ${e.message}\n`);
    // Exit 1 so caller knows to fall back to tfidf
    process.exit(1);
  }
})();
