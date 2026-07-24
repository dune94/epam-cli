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

// A plain existence check accepts a truncated/corrupt db as "indexed" — a
// real live failure mode: `codegraph init` writes .codegraph/.gitignore
// before the db, so a process killed mid-write (e.g. SIGKILL from an
// operator abort, OOM, disk-full) leaves a directory that LOOKS indexed
// (the dir + .gitignore exist) with an empty or truncated codegraph.db that
// never gets re-indexed on the next run, since the check never looked past
// "does the file exist". Found live 2026-07-23 (Metrolinx azure.commerce.cdts):
// .codegraph/ contained only .gitignore, no db at all, after an aborted run —
// re-running `codegraph init` standalone fixed it instantly, proving the
// indexer itself works fine; the check just couldn't tell "indexed" from
// "attempted and interrupted". Validates the real SQLite magic header
// ("SQLite format 3\0", the first 16 bytes of every valid SQLite file)
// instead of just checking the path exists.
function isCodeGraphIndexed(repoPath) {
  const dbPath = path.join(repoPath, '.codegraph', 'codegraph.db');
  let fd;
  try {
    fd = fs.openSync(dbPath, 'r');
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, 16, 0);
    return bytesRead === 16 && header.toString('utf8', 0, 15) === 'SQLite format 3';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// ensureIndexed(repoPath) — the single robustness guarantee that makes the
// "index keeps disappearing mid-run" problem IRRELEVANT regardless of cause.
// The index is protected only by an untracked .codegraph/.gitignore, which
// `git clean -fd` strips (exposing the db to deletion on any later clean).
// We add `-e .codegraph` to the git-clean sites we know of, but rather than
// depend on having found EVERY clean, every consumer that needs the index
// calls this first: if it's missing/invalid at the moment of use, rebuild it
// on demand (~1s). Returns true if the index is usable afterward.
function ensureIndexed(repoPath) {
  if (isCodeGraphIndexed(repoPath)) {
    // Already indexed — still (re)apply the git-clean protection, idempotently,
    // in case a prior run indexed it before this protection existed.
    protectIndexFromGitClean(repoPath);
    return true;
  }
  try {
    initCodeGraph(repoPath, { quiet: true }); // this also applies the protection
  } catch {
    return false;
  }
  return isCodeGraphIndexed(repoPath);
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
  protectIndexFromGitClean(repoPath);
  if (!quiet) log('CodeGraph init complete.');
}

// protectIndexFromGitClean(repoPath) — the DEFINITIVE fix for "the index keeps
// disappearing mid-run". The index is only protected by an untracked
// .codegraph/.gitignore, which `git clean -fd` strips on its first pass —
// exposing codegraph.db to deletion on any later clean. Empirically proven
// (2026-07-23): `.codegraph/` in the repo's LOCAL .git/info/exclude makes the
// index survive any number of `git clean -fd` passes, because git treats it as
// ignored and `git clean -fd` never removes ignored paths (only `-x` would).
// .git/info/exclude is a per-repo LOCAL ignore — untracked, never part of the
// working tree — so this is NOT a write to the client repo's tracked files.
// Belt-and-suspenders with ensureIndexed()'s rebuild-on-demand: this prevents
// the deletion; ensureIndexed recovers from any deletion this can't prevent
// (e.g. a non-git rm, or an interrupted init).
function protectIndexFromGitClean(repoPath) {
  try {
    const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.dirname(excludePath))) return; // not a standard git repo layout
    let current = '';
    try { current = fs.readFileSync(excludePath, 'utf8'); } catch { /* file may not exist yet */ }
    if (!/^\.codegraph\/?\s*$/m.test(current)) {
      fs.appendFileSync(excludePath, (current.endsWith('\n') || current === '' ? '' : '\n') + '.codegraph/\n');
    }
  } catch { /* best-effort — ensureIndexed still recovers if this couldn't run */ }
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

// exploreCandidateFiles(query, repoPath, topN) — runs `codegraph explore` and
// returns the ranked repo-relative file paths (dedup, rank order preserved),
// for deterministic fix-site injection. CodeGraph is a static FTS5 index, so
// identical (query, repo) → identical ranking. Proven live 2026-07-23
// (AMSD-1820): a domain-noun query ranks the true fix site #1, 3x straight.
// Returns [] if the index is unavailable/unindexed (caller falls back to Semble).
function exploreCandidateFiles(query, repoPath, topN = 3) {
  if (!ensureIndexed(repoPath)) return [];
  const raw = exploreCodeGraph(query, repoPath, { maxFiles: Math.max(8, topN * 2) });
  if (!raw) return [];
  const files = [];
  const seen = new Set();
  // Blast-radius lines reference symbols as `Name` (src/path.ts:line ...).
  for (const m of raw.matchAll(/\(src\/[A-Za-z0-9/_.-]+\.[a-z]+/g)) {
    const f = m[0].slice(1); // drop leading '('
    if (!seen.has(f)) { seen.add(f); files.push(f); }
  }
  return files.slice(0, topN);
}

// affectedTestFiles(changedFile, repoPath) — runs `codegraph affected` and
// returns the test files that exercise the given changed source file. An
// EMPTY array means the changed code has NO covering tests. This is the
// brownfield test-coverage gate signal: a modified file that already has
// covering tests needs NO new test (the existing regression net proves it);
// only a modified file with zero covering tests warrants ONE targeted test
// for the changed behavior. Deliberately conservative — this is what keeps
// brownfield from generating "wild tests that aren't necessary".
function affectedTestFiles(changedFile, repoPath) {
  const bin = resolveCodeGraphBin();
  if (!bin || !ensureIndexed(repoPath)) return [];
  try {
    const raw = execSync(
      `"${bin}" affected "${changedFile}" --path "${repoPath}"`,
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
    );
    // "No test files affected..." → uncovered. Otherwise lines list test paths.
    if (/No test files affected/i.test(raw)) return [];
    const files = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/(\S+\.(?:test|spec)\.[jt]sx?|\S*__tests__\/\S+\.[jt]sx?)/);
      if (m) files.push(m[1]);
    }
    return files;
  } catch { return []; }
}

// uncoveredChangedFiles(changedFiles, repoPath) — the brownfield test gate.
// Given the files a story actually changed, returns ONLY those with no
// covering tests. These — and only these — should get a single targeted test.
// Everything else is already covered by the existing suite (which the Step 5
// regression guard + Step 4.5 unit gate already run). Returns [] when
// CodeGraph is unavailable (caller should then fall back to the existing
// all-or-nothing behavior, not silently skip coverage).
function uncoveredChangedFiles(changedFiles, repoPath) {
  if (!ensureIndexed(repoPath)) return null; // null = "cannot determine" (distinct from [] = "all covered")
  const impl = (changedFiles || []).filter(
    (f) => /\.[jt]sx?$/.test(f) && !/\.(test|spec)\.[jt]sx?$/.test(f) && !/__tests__\//.test(f)
  );
  return impl.filter((f) => affectedTestFiles(f, repoPath).length === 0);
}

module.exports = { resolveCodeGraphBin, isCodeGraphIndexed, ensureIndexed, initCodeGraph, queryCodeGraph, exploreCodeGraph, exploreCandidateFiles, affectedTestFiles, uncoveredChangedFiles };
