#!/usr/bin/env node
/**
 * brownfield-context.js — Brownfield context retrieval for CPA.
 *
 * Stage 1 — git repo: walks target repo via git ls-files, chunks source
 * files, scores with TF-IDF.
 *
 * Stage 2 — external stubs / live Jira:
 *   Reads <repo-root>/.epam/brownfield/ (or --stub-dir) for:
 *     jira.json       — [{key, summary, description, acceptanceCriteria[]}]
 *     confluence.md   — markdown architecture/runbook docs
 *   When JIRA_URL + JIRA_EMAIL + JIRA_TOKEN are set, fetches live issue
 *   data for each key in jira.json instead of using stub content.
 *
 * Usage:
 *   node brownfield-context.js \
 *       --repo-root <path> \
 *       --query    <text> \
 *      [--top <n>]             default: 5
 *      [--chunk-size <lines>]  default: 25
 *      [--max-file-kb <n>]     default: 100
 *      [--stub-dir <path>]     default: <repo-root>/.epam/brownfield
 *
 * Output: JSON array of {source, score, chunk} to stdout.
 *   source formats: "git:<path>", "stub:jira:<key>", "jira:<key>", "stub:confluence"
 * Errors: stderr only. Exits 0 with [] on missing repo (non-fatal).
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
// Stage 2: stub dir defaults to <repo-root>/.epam/brownfield
const STUB_DIR    = getArg('--stub-dir',
  REPO_ROOT ? path.join(REPO_ROOT, '.epam', 'brownfield') : '');

const JIRA_URL   = process.env.JIRA_URL   || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const LIVE_JIRA  = !!(JIRA_URL && JIRA_EMAIL && JIRA_TOKEN);

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

// ── Stage 2: stub / live Jira loaders ─────────────────────────────────────

function loadJiraStubs() {
  const file = path.join(STUB_DIR, 'jira.json');
  if (!fs.existsSync(file)) return [];
  try {
    const issues = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(issues) ? issues : [];
  } catch (e) {
    process.stderr.write(`brownfield-context: jira.json parse error: ${e.message}\n`);
    return [];
  }
}

function issueToChunk(issue, sourcePrefix) {
  const acs = Array.isArray(issue.acceptanceCriteria)
    ? issue.acceptanceCriteria.join('\n')
    : (issue.acceptanceCriteria || '');
  const text = [
    issue.summary || issue.title || '',
    issue.description || '',
    acs,
  ].filter(Boolean).join('\n').trim();
  return { source: `${sourcePrefix}:${issue.key}`, chunk: text };
}

async function fetchLiveIssue(key) {
  const https  = require('https');
  const urlMod = require('url');
  return new Promise((resolve) => {
    const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
    const apiPath = `/rest/api/3/issue/${key}?fields=summary,description,labels,customfield_10016`;
    const parsed  = urlMod.parse(`${JIRA_URL}${apiPath}`);
    const req     = https.request({
      hostname: parsed.hostname, port: parsed.port || 443, path: parsed.path, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try {
          const data   = JSON.parse(raw);
          const fields = data.fields || {};
          // ADF description → plain text
          const descText = typeof fields.description === 'string'
            ? fields.description
            : (fields.description && fields.description.content
              ? fields.description.content.map(n =>
                  (n.content || []).map(t => t.text || '').join(' ')
                ).join('\n')
              : '');
          resolve({ key, summary: fields.summary || key, description: descText,
                    acceptanceCriteria: [] });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function loadExternalChunks() {
  const chunks = [];
  if (!fs.existsSync(STUB_DIR)) return chunks;

  // ── Jira issues ──────────────────────────────────────────────────────────
  const stubs = loadJiraStubs();
  if (stubs.length > 0) {
    if (LIVE_JIRA) {
      process.stderr.write(`brownfield-context: fetching ${stubs.length} issues from live Jira\n`);
      for (const stub of stubs) {
        const live = await fetchLiveIssue(stub.key);
        const issue = live || stub; // fall back to stub if fetch fails
        const prefix = live ? 'jira' : 'stub:jira';
        chunks.push(issueToChunk(issue, prefix));
      }
    } else {
      for (const stub of stubs) {
        chunks.push(issueToChunk(stub, 'stub:jira'));
      }
    }
  }

  // ── Confluence docs ──────────────────────────────────────────────────────
  const confFile = path.join(STUB_DIR, 'confluence.md');
  if (fs.existsSync(confFile)) {
    try {
      const lines = fs.readFileSync(confFile, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
        const text = lines.slice(i, i + CHUNK_SIZE).join('\n').trim();
        if (text.length > 20) chunks.push({ source: 'stub:confluence', chunk: text });
      }
    } catch { /* skip */ }
  }

  return chunks;
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const queryTokens = tokenize(QUERY);
    if (queryTokens.length === 0) {
      process.stdout.write('[]\n');
      process.exit(0);
    }

    // Stage 1: git repo chunks
    const allChunks = [];
    const files = listFiles(REPO_ROOT);

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

    // Stage 2: external stubs / live Jira + Confluence
    const externalChunks = await loadExternalChunks();
    allChunks.push(...externalChunks);

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
