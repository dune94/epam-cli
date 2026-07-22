#!/usr/bin/env node
/**
 * codeline-discovery.js — Brownfield codeline discovery for the Jira pipeline.
 *
 * Scans JIRA_CODELINE_ROOT, builds a repo manifest from the filesystem, then
 * calls an LLM (via ai-run.sh) to match the supplied Jira tickets to the
 * correct local repositories.  The caller (ingest-jira-tickets.sh) exports
 * JIRA_CODELINES and JIRA_WORKTREE_<NAME> from this output so that the
 * downstream synthesize-prd-from-jira.js step can build outputDirs without
 * any hardcoded worktree paths in the project env file.
 *
 * This module is an internal pipeline stage — not a standalone tool.  It is
 * invoked exclusively from ingest-jira-tickets.sh when EPAM_BROWNFIELD=1 and
 * JIRA_CODELINES is absent.  Greenfield runs never reach this code.
 *
 * Usage (called by ingest-jira-tickets.sh):
 *   node codeline-discovery.js --issues <path> --root <dir> --out <path> [--dry-run]
 *
 * Output JSON (written to --out):
 *   { "codelines": [{ "name": "cdts", "path": "/abs/path", "reason": "..." }] }
 *
 * Env vars consumed:
 *   ORCH_GATE_MODEL   — LLM model for classification (falls back to EPAM_MODEL)
 *   NODE_BIN          — node binary path
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// Lazy-load semble-context and codegraph-context; both fail gracefully when absent.
let _semble = null;
function getSemble() {
  if (_semble) return _semble;
  try {
    _semble = require('./semble-context');
  } catch {
    _semble = { sembleSearch: () => ({ results: [] }), resolveSembleBin: () => null };
  }
  return _semble;
}

let _codegraph = null;
function getCodeGraph() {
  if (_codegraph) return _codegraph;
  try {
    _codegraph = require('./codegraph-context');
  } catch {
    _codegraph = { isCodeGraphIndexed: () => false, queryCodeGraph: () => [] };
  }
  return _codegraph;
}

// ── Arg parsing ────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const getArg  = (flag, def = '') => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
const DRY_RUN = argv.includes('--dry-run') || process.env.CODELINE_DISCOVERY_DRY_RUN === '1';
const MODEL   = getArg('--model', process.env.ORCH_GATE_MODEL || process.env.EPAM_MODEL || 'claude-haiku-4-5-20251001');

const ISSUES_PATH = getArg('--issues');
const ROOT_DIR    = getArg('--root', process.env.JIRA_CODELINE_ROOT || '');
const OUT_PATH    = getArg('--out', '');

if (!ISSUES_PATH || !ROOT_DIR || !OUT_PATH) {
  process.stderr.write('Usage: node codeline-discovery.js --issues <path> --root <dir> --out <path>\n');
  process.exit(1);
}

const SCRIPT_DIR = path.join(__dirname, '..');
const AI_RUN_SH  = path.join(SCRIPT_DIR, 'ai-run.sh');

const log  = msg => process.stderr.write(`[codeline-discovery] ${msg}\n`);
const warn = msg => process.stderr.write(`[codeline-discovery] WARN: ${msg}\n`);

// ── Repo manifest builder ──────────────────────────────────────────────────
// Scans JIRA_CODELINE_ROOT and returns an array of repo descriptors.
// Only directories that are git repos are included (non-git dirs are skipped).

function buildRepoManifest(rootDir) {
  const entries = [];
  let names;
  try {
    names = fs.readdirSync(rootDir).sort();
  } catch (e) {
    throw new Error(`Cannot read JIRA_CODELINE_ROOT: ${rootDir} — ${e.message}`);
  }

  for (const name of names) {
    const full = path.join(rootDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    // Only include git repos — bare directories without .git have no meaningful
    // commit history and cannot serve as a brownfield worktree baseline.
    const isGit = fs.existsSync(path.join(full, '.git'));
    if (!isGit) continue;

    // Exclude docs.* repos — documentation projects are never in scope for
    // brownfield code changes and add Semble noise (they match ticket keywords
    // via documentation content rather than implementation code).
    if (/^docs\./i.test(name)) {
      log(`Skipping docs repo (not in maintenance scope): ${name}`);
      continue;
    }

    // Stack detection from manifest files
    let stack = 'unknown';
    let packageName = name;
    let description = '';

    if (fs.existsSync(path.join(full, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
        stack       = 'typescript';
        packageName = pkg.name || name;
        description = pkg.description || '';
      } catch { /* use defaults */ }
    } else if (fs.existsSync(path.join(full, 'pyproject.toml'))) {
      stack = 'python';
    } else if (fs.existsSync(path.join(full, 'go.mod'))) {
      stack = 'go';
    }

    // Short README excerpt for extra context (first non-empty line after headings)
    let readmeExcerpt = '';
    for (const readmeName of ['README.md', 'readme.md', 'README.txt']) {
      const readmePath = path.join(full, readmeName);
      if (fs.existsSync(readmePath)) {
        try {
          const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
          const excerpt = lines.find(l => l.trim() && !l.startsWith('#'));
          readmeExcerpt = (excerpt || '').slice(0, 120);
        } catch { /* ignore */ }
        break;
      }
    }

    entries.push({ name, path: full, stack, packageName, description, readmeExcerpt });
  }

  return entries;
}

// ── Repo scoring ───────────────────────────────────────────────────────────
// Three-tier scoring. Runs every tier that is available so the highest-signal
// method always wins regardless of which tools are installed.
//
//   Tier 1 — name/description/readme keyword match   (fast, zero I/O, always)
//   Tier 2 — CodeGraph FTS5 symbol-name query        (CODEGRAPH_ENABLED=1, indexed repos only)
//             Deterministic: finds functions literally named "applyReportDiscounts";
//             5 pts per symbol hit, maximum 100 pts. Decisive when the target repo
//             is indexed — an indexed repo wins by 50-100 pts over unindexed ones.
//   Tier 3 — Semble semantic search                  (SEMBLE_ENABLED=1, all repos)
//             Probabilistic: cosine similarity over embeddings. Kept as a fallback
//             for repos that are not yet indexed in CodeGraph. Brittle (1-point
//             margins), hence demoted to Tier 3.
//
// Returns repos sorted descending by combined score, sliced to topN.

function scoreRepos(issues, manifest, topN = 8) {
  const text = issues.map(i => `${i.title || ''} ${(i.description || '').slice(0, 500)}`).join(' ');
  const words = [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4)
      .filter(w => !['with','that','this','from','have','will','when','then','also','been','were','they','them'].includes(w))
  )];

  const cgEnabled   = process.env.CODEGRAPH_ENABLED === '1';
  const cg          = cgEnabled ? getCodeGraph() : null;
  const cgQuery     = words.slice(0, 10).join(' ');

  const sembleEnabled = process.env.SEMBLE_ENABLED === '1';
  const semble        = sembleEnabled ? getSemble() : null;
  const sembleBin     = semble ? semble.resolveSembleBin() : null;
  // Action-verb prefix targets the SERVICE that HANDLES this domain (not docs that MENTION it).
  const sembleQuery   = `applies handles processes resolves ${words.slice(0, 15).join(' ')}`.slice(0, 300);

  const scored = manifest.map(repo => {
    let score = 0;

    // Tier 1 — name/description keyword match (no I/O, always runs)
    const repoText = `${repo.name} ${repo.packageName} ${repo.description} ${repo.readmeExcerpt}`.toLowerCase();
    for (const word of words) {
      if (repoText.includes(word)) score += 3;
    }

    // Tier 2 — CodeGraph FTS5 symbol-name query (indexed repos only).
    // BM25 scores are 70-100 per match. We count results (capped at 20) × 5 pts
    // so an indexed repo with 10 symbol hits scores +50, far ahead of Tier 3.
    if (cgEnabled && cg && cgQuery && cg.isCodeGraphIndexed(repo.path)) {
      try {
        const results = cg.queryCodeGraph(cgQuery, repo.path, 20);
        score += Math.min((results || []).length, 20) * 5;
      } catch { /* codegraph unavailable for this repo — skip */ }
    }

    // Tier 3 — Semble semantic search (all repos, probabilistic fallback).
    // Runs only when CodeGraph didn't already score this repo decisively.
    if (sembleEnabled && sembleBin && sembleQuery) {
      try {
        const result = semble.sembleSearch(sembleQuery, repo.path, 3, 10);
        const sembleScore = (result.results || []).reduce((s, r) => s + (r.score || 0), 0);
        // Semble cosine-similarity scores are ~0.01–0.10; multiply by 1000 to integer scale.
        score += Math.round(sembleScore * 1000);
      } catch { /* semble unavailable for this repo — skip */ }
    }

    return { ...repo, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN);
  log(`Repo scoring: top ${top.length} candidate(s) from ${manifest.length} repos (scores: ${top.map(r => `${r.name}=${r.score}`).join(', ')})`);
  return top;
}

// ── Best-candidate selection (used by dry-run and LLM-failure fallback) ───
// Picks the highest-scored repo from a pre-scored (sorted descending) list.
// Never selects by alphabetical position — that was the bug that caused wrong
// codeline selection when the LLM timed out.

function selectBestCandidate(scored) {
  if (scored.length === 0) {
    throw new Error('No git repositories found under JIRA_CODELINE_ROOT — cannot discover codelines.');
  }
  const repo = scored[0]; // already sorted descending by scoreRepos()
  const name = deriveCodelineName(repo.name);
  return { codelines: [{ name, path: repo.path, reason: `[scored-fallback] Highest candidate (score: ${repo.score})` }] };
}

// ── Codeline name derivation ───────────────────────────────────────────────
// Produces a short lowercase identifier from a directory name.
// e.g. "azure.commerce.cdts" → "cdts"  "next.gotransit.com" → "gotransit"

function deriveCodelineName(dirName) {
  const parts = dirName.replace(/\.(com|org|net|io|dev)$/, '').split(/[.\-_]+/);
  // Prefer the last meaningful segment (avoids generic prefixes like "azure", "next")
  const generic = new Set(['azure', 'next', 'react', 'api', 'app', 'web', 'lib', 'ui', 'docs', 'secure', 'login', 'tools']);
  const meaningful = parts.filter(p => p.length >= 2 && !generic.has(p));
  return (meaningful.pop() || parts[parts.length - 1] || dirName).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

// ── LLM discovery call ─────────────────────────────────────────────────────

function buildDiscoveryPrompt(issues, manifest) {
  const manifestSummary = manifest.map(r =>
    `- dir: ${r.name}\n  path: ${r.path}\n  stack: ${r.stack}\n  package: ${r.packageName}` +
    (r.description ? `\n  description: ${r.description}` : '') +
    (r.readmeExcerpt ? `\n  readme: ${r.readmeExcerpt}` : '')
  ).join('\n\n');

  const issuesSummary = issues.map(i =>
    `- key: ${i.jiraKey}\n  title: ${i.title}\n  description: ${(i.description || '').slice(0, 300)}`
  ).join('\n\n');

  return `You are the codeline-discovery agent for a brownfield engineering pipeline.

Your task: given a set of Jira tickets and a manifest of local code repositories,
identify which repository (or repositories) each ticket's changes belong to.

JIRA TICKETS:
${issuesSummary}

REPOSITORY MANIFEST (git repos only):
${manifestSummary}

Rules:
1. Match each ticket to the repository whose name, packageName, or description
   best fits the ticket's domain. Use context clues: service names, domain terms,
   technology references, component names, file path mentions.
2. Return ONLY the repos that are genuinely needed for the given tickets.
   Do not return repos that are unlikely to require changes.
3. Assign each selected repo a short codeline identifier: 2–20 chars, lowercase,
   alphanumeric only, no dots or dashes. Derive it from the directory name
   (e.g. "cdts" for "azure.commerce.cdts", "gotransit" for "next.gotransit.com").
4. If all tickets clearly belong to one repo, return exactly one entry.
5. "reason" must be one sentence explaining why this repo was selected.

Output format (strict JSON, no markdown fences, no preamble, no trailing text):
{
  "codelines": [
    { "name": "cdts", "path": "/absolute/path/to/repo", "reason": "..." }
  ]
}`;
}

function callLlm(prompt) {
  const tmpPrompt = `/tmp/codeline-discovery-prompt-${process.pid}.txt`;
  fs.writeFileSync(tmpPrompt, prompt);
  try {
    const cmd = `bash ${AI_RUN_SH} --model ${MODEL} < ${tmpPrompt} 2>/dev/null`;
    const raw = execSync(cmd, {
      encoding:   'utf8',
      timeout:    300000,
      maxBuffer:  10 * 1024 * 1024,
      env:        { ...process.env },
    }).trim();

    if (!raw) throw new Error('Empty response from ai-run.sh');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in LLM response: ${raw.slice(0, 200)}`);

    return JSON.parse(jsonMatch[0]);
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const issues = JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
  log(`Scanning ${ROOT_DIR} for git repositories...`);
  const manifest = buildRepoManifest(ROOT_DIR);
  log(`Found ${manifest.length} git repo(s) in codeline root.`);

  if (manifest.length === 0) {
    process.stderr.write('[codeline-discovery] ERROR: No git repositories found in JIRA_CODELINE_ROOT.\n');
    process.exit(1);
  }

  // Score + rank repos (always — used for both the LLM candidate list and fallback selection).
  const candidates = scoreRepos(issues, manifest);

  let result;
  if (DRY_RUN) {
    // Dry-run: use the highest-scored candidate, never the first alphabetically.
    warn('DRY-RUN mode — skipping LLM call, selecting highest-scored repo.');
    result = selectBestCandidate(candidates);
  } else {
    log(`Calling LLM (${MODEL}) to match ${issues.length} ticket(s) to ${candidates.length} candidate repo(s)...`);
    const prompt = buildDiscoveryPrompt(issues, candidates);
    try {
      result = callLlm(prompt);
    } catch (e) {
      warn(`LLM call failed: ${e.message}. Using highest-scored candidate as fallback.`);
      result = selectBestCandidate(candidates);
    }
  }

  // Validate: paths must be absolute and must exist
  const validated = (result.codelines || []).filter(cl => {
    if (!path.isAbsolute(cl.path)) {
      warn(`Skipping codeline '${cl.name}' — path is not absolute: ${cl.path}`);
      return false;
    }
    if (!fs.existsSync(cl.path)) {
      warn(`Skipping codeline '${cl.name}' — path does not exist: ${cl.path}`);
      return false;
    }
    if (!fs.existsSync(path.join(cl.path, '.git'))) {
      warn(`Skipping codeline '${cl.name}' — not a git repo: ${cl.path}`);
      return false;
    }
    return true;
  });

  if (validated.length === 0) {
    process.stderr.write('[codeline-discovery] ERROR: Discovery returned no valid codeline paths.\n');
    process.exit(1);
  }

  const output = { codelines: validated };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  for (const cl of validated) {
    log(`  → codeline '${cl.name}' = ${cl.path} (${cl.reason})`);
  }
  log(`Discovery complete. ${validated.length} codeline(s) identified.`);
})();
