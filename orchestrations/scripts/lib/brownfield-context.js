#!/usr/bin/env node
/**
 * brownfield-context.js — Git repo context retrieval for CPA brownfield pass.
 *
 * Walks the target repo via `git ls-files` (falls back to recursive find for
 * non-git dirs), chunks source files, and scores chunks against the query
 * using TF-IDF term frequency. Same CLI interface and output shape as
 * tfidf.js and semantic-search.js.
 *
 * Usage:
 *   node brownfield-context.js \
 *       --repo-root <path> \
 *       --query    <text> \
 *      [--top <n>]             default: 5
 *      [--chunk-size <lines>]  default: 25
 *      [--max-file-kb <n>]     default: 100
 *
 * Output: JSON array of {source, score, chunk} to stdout.
 *   source format: "git:<relative-path>"
 * Errors: stderr only. Exits 0 with [] on missing/non-git repo (non-fatal).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Arg parsing ────────────────────────────────────────────────────────────

const argv   = process.argv.slice(2);
const getArg = (flag, def = '') => {
  const i = argv.indexOf(flag);
  return (i !== -1 && argv[i + 1] !== undefined) ? argv[i + 1] : def;
};

const REPO_ROOT   = getArg('--repo-root');
const QUERY       = getArg('--query');
const TOP_K       = parseInt(getArg('--top', '5'), 10);
const CHUNK_SIZE  = parseInt(getArg('--chunk-size', '25'), 10);
const MAX_FILE_KB = parseInt(getArg('--max-file-kb', '100'), 10);

if (!QUERY) {
  process.stderr.write('Usage: node brownfield-context.js --repo-root <path> --query <text>\n');
  process.exit(1);
}

if (!REPO_ROOT || !fs.existsSync(REPO_ROOT)) {
  process.stderr.write(`brownfield-context: repo root not found: ${REPO_ROOT}\n`);
  process.stdout.write('[]\n');
  process.exit(0);
}

// ── File discovery ─────────────────────────────────────────────────────────

const INCLUDE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.rb', '.rs', '.cs', '.cpp', '.c', '.h',
  '.md', '.txt', '.sh', '.bash',
  '.json', '.yaml', '.yml', '.toml', '.env.example',
  '.css', '.scss', '.html', '.sql',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', 'vendor', 'coverage', '.turbo', '.cache',
]);

function listFiles(repoRoot) {
  try {
    const out = execSync('git ls-files --cached', {
      cwd: repoRoot, encoding: 'utf8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    // Not a git repo — walk the directory tree
    const files = [];
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
        } else {
          files.push(path.relative(repoRoot, path.join(dir, e.name)));
        }
      }
    }
    walk(repoRoot);
    return files;
  }
}

// ── Chunking ───────────────────────────────────────────────────────────────

function chunkFile(relPath, content) {
  const lines  = content.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const text = lines.slice(i, i + CHUNK_SIZE).join('\n').trim();
    if (text.length > 20) {
      chunks.push({ source: `git:${relPath}`, chunk: text });
    }
  }
  return chunks;
}

// ── TF-IDF scoring ─────────────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(t => t.length > 2);
}

function scoreChunk(chunkText, queryTokens) {
  const text  = chunkText.toLowerCase();
  const words = tokenize(chunkText);
  if (words.length === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    let pos = 0;
    while ((pos = text.indexOf(token, pos)) !== -1) { hits++; pos += token.length; }
  }
  // Normalise: hits per query token per 25 words, capped at 1.0
  const norm = hits / (queryTokens.length * Math.max(words.length / 25, 1));
  return Math.min(1, norm);
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const queryTokens = tokenize(QUERY);
    if (queryTokens.length === 0) {
      process.stdout.write('[]\n');
      process.exit(0);
    }

    const files = listFiles(REPO_ROOT);
    const allChunks = [];

    for (const relPath of files) {
      const ext   = path.extname(relPath).toLowerCase();
      const parts = relPath.split('/');

      if (!INCLUDE_EXT.has(ext)) continue;
      if (parts.some(p => SKIP_DIRS.has(p))) continue;

      const fullPath = path.join(REPO_ROOT, relPath);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_KB * 1024) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        allChunks.push(...chunkFile(relPath, content));
      } catch { /* skip unreadable */ }
    }

    if (allChunks.length === 0) {
      process.stdout.write('[]\n');
      process.exit(0);
    }

    const results = allChunks
      .map(c => ({ source: c.source, chunk: c.chunk, score: scoreChunk(c.chunk, queryTokens) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(c => ({ source: c.source, score: Math.round(c.score * 10000) / 10000, chunk: c.chunk }));

    process.stdout.write(JSON.stringify(results) + '\n');
    process.exit(0);

  } catch (e) {
    process.stderr.write(`brownfield-context: error: ${e.message}\n`);
    process.exit(1);
  }
})();
