#!/usr/bin/env node
/**
 * semble-context.js — Retrieves relevant code snippets from a local repo using semble.
 *
 * Wraps the `semble search` CLI to give LLM agents targeted code context (~2k tokens)
 * instead of full-file reads (~100k tokens). Used by:
 *   - codeline-discovery.js  → scores repos by semantic relevance (replaces grep)
 *   - spec-mode-runner.js    → injects existing-code context into spec prompts
 *
 * Usage:
 *   node semble-context.js --query "text" --path /repo [--limit 5] [--max-lines 20]
 *                          [--format text|json]
 *
 * Output:
 *   --format json  (default) → raw semble JSON { query, results: [...] }
 *   --format text            → human-readable code blocks for LLM prompt injection
 *
 * Env vars:
 *   SEMBLE_BIN   — path to semble binary (default: resolved from PATH)
 *   SEMBLE_ENABLED — must be "1" for live calls; any other value returns empty result
 */

'use strict';

const { execSync } = require('child_process');
const path         = require('path');

const argv    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };

const QUERY     = getArg('--query', '');
const REPO_PATH = getArg('--path', '');
const LIMIT     = parseInt(getArg('--limit', '5'), 10);
const MAX_LINES = getArg('--max-lines', '20');
const FORMAT    = getArg('--format', 'json');
const ENABLED   = process.env.SEMBLE_ENABLED === '1';

const log  = msg => process.stderr.write(`[semble-context] ${msg}\n`);
const warn = msg => process.stderr.write(`[semble-context] WARN: ${msg}\n`);

// ── Semble binary resolution ───────────────────────────────────────────────
function resolveSembleBin() {
  if (process.env.SEMBLE_BIN) return process.env.SEMBLE_BIN;
  try {
    return execSync('which semble', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ── Core search call ───────────────────────────────────────────────────────
function sembleSearch(query, repoPath, limit, maxLines) {
  const bin = resolveSembleBin();
  if (!bin) {
    warn('semble not found in PATH — install with: pip install semble');
    return { query, results: [] };
  }

  const safeQuery = query.replace(/"/g, '\\"');
  const cmd = `"${bin}" search "${safeQuery}" "${repoPath}" -k ${limit} --max-snippet-lines ${maxLines} 2>/dev/null`;

  try {
    const raw = execSync(cmd, {
      encoding:  'utf8',
      timeout:   60000,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();

    if (!raw) return { query, results: [] };

    // semble outputs one JSON object per line when multiple results; try array parse first
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      warn(`No JSON in semble output: ${raw.slice(0, 200)}`);
      return { query, results: [] };
    }
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    warn(`semble search failed: ${e.message.slice(0, 200)}`);
    return { query, results: [] };
  }
}

// ── Text formatter for LLM prompt injection ────────────────────────────────
function formatAsText(result) {
  if (!result.results || result.results.length === 0) {
    return '(no relevant existing code found)';
  }
  return result.results.map(r => {
    const header = `// ${r.file_path} (lines ${r.start_line}–${r.end_line}, relevance: ${r.score.toFixed(4)})`;
    return `${header}\n${r.content}`;
  }).join('\n\n---\n\n');
}

// ── Standalone mode ────────────────────────────────────────────────────────
if (require.main === module) {
  if (!QUERY || !REPO_PATH) {
    process.stderr.write('Usage: node semble-context.js --query "text" --path /repo [--limit 5] [--max-lines 20] [--format text|json]\n');
    process.exit(1);
  }

  if (!ENABLED) {
    warn('SEMBLE_ENABLED is not "1" — returning empty result. Set SEMBLE_ENABLED=1 to activate.');
    process.stdout.write(FORMAT === 'text' ? '(semble disabled)\n' : '{"query":"","results":[]}\n');
    process.exit(0);
  }

  log(`Searching "${QUERY.slice(0, 80)}..." in ${REPO_PATH} (top ${LIMIT})`);
  const result = sembleSearch(QUERY, REPO_PATH, LIMIT, MAX_LINES);
  log(`Found ${result.results.length} snippet(s)`);

  if (FORMAT === 'text') {
    process.stdout.write(formatAsText(result) + '\n');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

// ── Module API (used by codeline-discovery.js and spec-mode-runner.js) ────
module.exports = { sembleSearch, formatAsText, resolveSembleBin };
