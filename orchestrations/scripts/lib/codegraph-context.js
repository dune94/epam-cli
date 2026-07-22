#!/usr/bin/env node
/**
 * codegraph-context.js — Wrapper around the CodeGraph CLI for brownfield pipeline use.
 *
 * CodeGraph builds a deterministic static-analysis graph of a codebase (tree-sitter AST,
 * SQLite + FTS5, call/import/inheritance edges).  It gives AI agents exact symbol source,
 * callers, callees, and blast-radius analysis — no embedding approximation, no probability.
 *
 * Used by:
 *   - spec-mode-runner.js  → inject exact fix-site source + callers into brownfield prompts
 *   - codeline-discovery.js → score repos by indexed symbol matches (Tier 2, beats Semble)
 *
 * Prerequisites:
 *   npm i -g @colbymchenry/codegraph
 *   codegraph init <repo-path>           (one-time per repo; ~600 ms for 1k-file repo)
 *
 * Env vars:
 *   CODEGRAPH_BIN      — override binary path (default: resolved from PATH)
 *   CODEGRAPH_ENABLED  — must be "1" for live calls
 */

'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const log  = msg => process.stderr.write(`[codegraph-context] ${msg}\n`);
const warn = msg => process.stderr.write(`[codegraph-context] WARN: ${msg}\n`);

// ── Binary resolution ──────────────────────────────────────────────────────

function resolveCodeGraphBin() {
  if (process.env.CODEGRAPH_BIN) return process.env.CODEGRAPH_BIN;
  try {
    return execSync('which codegraph', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// ── Index state check ──────────────────────────────────────────────────────
// Fast filesystem check — avoids a subprocess call per repo during discovery.

function isCodeGraphIndexed(repoPath) {
  return fs.existsSync(path.join(repoPath, '.codegraph', 'codegraph.db'));
}

// ── Init ───────────────────────────────────────────────────────────────────
// Builds (or rebuilds) the index for a repo. ~600 ms for a 1 k-file TypeScript
// repo.  Writes .codegraph/codegraph.db inside the repo.

function initCodeGraph(repoPath, { quiet = false } = {}) {
  const bin = resolveCodeGraphBin();
  if (!bin) throw new Error('codegraph binary not found — run: npm i -g @colbymchenry/codegraph');
  if (!quiet) log(`Initialising CodeGraph index for ${repoPath}...`);
  execSync(`"${bin}" init "${repoPath}"`, {
    encoding:  'utf8',
    timeout:   180000,
    stdio:     quiet ? 'pipe' : 'inherit',
  });
  if (!quiet) log('CodeGraph init complete.');
}

// ── Symbol query ───────────────────────────────────────────────────────────
// FTS5 BM25 search over symbol names, qualified names, docstrings, and
// signatures.  Returns an array of { node, score } objects sorted by score.
// BM25 scores for strong matches are typically 70–100.

function queryCodeGraph(keywords, repoPath, limit = 10) {
  const bin = resolveCodeGraphBin();
  if (!bin) return [];
  const safeQuery = keywords.replace(/"/g, '\\"').slice(0, 200);
  try {
    const raw = execSync(
      `"${bin}" query "${safeQuery}" --path "${repoPath}" --json -l ${limit}`,
      { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
    ).trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    warn(`query failed for ${path.basename(repoPath)}: ${e.message.slice(0, 120)}`);
    return [];
  }
}

// ── Explore ────────────────────────────────────────────────────────────────
// Returns verbatim source of the most relevant symbols + call paths + blast
// radius, formatted as markdown.  Equivalent to the codegraph_explore MCP tool.
// maxFiles controls output size (~28 K chars per file in the default budget).

function exploreCodeGraph(query, repoPath, { maxFiles = 4, maxChars = 12000 } = {}) {
  const bin = resolveCodeGraphBin();
  if (!bin) return '';
  const safeQuery = query.replace(/"/g, '\\"').slice(0, 300);
  try {
    const raw = execSync(
      `"${bin}" explore "${safeQuery}" --path "${repoPath}" --max-files ${maxFiles}`,
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }
    ).trim();
    // Trim to token budget — truncate at a line boundary to avoid mid-code cuts
    if (raw.length <= maxChars) return raw;
    const truncated = raw.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return lastNewline > maxChars * 0.8 ? truncated.slice(0, lastNewline) : truncated;
  } catch (e) {
    warn(`explore failed: ${e.message.slice(0, 120)}`);
    return '';
  }
}

// ── Standalone mode ────────────────────────────────────────────────────────
if (require.main === module) {
  const argv   = process.argv.slice(2);
  const getArg = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
  const cmd    = argv[0];
  const query  = getArg('--query', '');
  const repoPath = getArg('--path', '');
  const limit  = parseInt(getArg('--limit', '10'), 10);

  if (!repoPath) {
    process.stderr.write('Usage: node codegraph-context.js <query|explore|status|init> --path /repo [--query "..."] [--limit N]\n');
    process.exit(1);
  }

  switch (cmd) {
    case 'status':
      process.stdout.write(JSON.stringify({ indexed: isCodeGraphIndexed(repoPath) }) + '\n');
      break;
    case 'init':
      initCodeGraph(repoPath);
      break;
    case 'query':
      process.stdout.write(JSON.stringify(queryCodeGraph(query, repoPath, limit), null, 2) + '\n');
      break;
    case 'explore':
      process.stdout.write(exploreCodeGraph(query, repoPath) + '\n');
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

module.exports = { resolveCodeGraphBin, isCodeGraphIndexed, initCodeGraph, queryCodeGraph, exploreCodeGraph };
