const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DASHBOARD_ROOT = path.join(__dirname, '..');
// Self-healing signals (healing-events.jsonl, dynamic tools) are written by
// claude.sh into the PROJECT's own output directory (OUTPUT_DIR), not into
// this epam-cli repo — e.g. run_healing_recorder() writes to
// "${OUTPUT_DIR:-$LOG_DIR}/healing-events.jsonl". DASHBOARD_ROOT itself stays
// hardcoded to this repo (profiles.json/profiles.json.original are genuinely
// repo-relative — the canonical floor restored at the start of every run),
// but the project-specific signals need a separate, config-driven root:
// EPAM_PROJECT_OUTPUT_DIR. Falls back to DASHBOARD_ROOT when unset so
// behavior for anyone not setting it is unchanged.
const PROJECT_OUTPUT_DIR = process.env.EPAM_PROJECT_OUTPUT_DIR || DASHBOARD_ROOT;

// Active PRD path — resolved the same way pre-run-reset.sh's compose override
// resolves /prd-dir, but for THIS Node process (the Eleventy watcher), which
// has no access to Docker mounts. pre-run-reset.sh writes the absolute PRD
// path into ACTIVE_PRD_POINTER on every invocation; fall back to the old
// symlinked orchestrations/prd.json when the pointer doesn't exist yet (never
// break an existing setup that hasn't run the updated pre-run-reset.sh).
// Found live 2026-07-13: orchestrations/dashboards/prd.json symlinks to
// orchestrations/prd.json — a dead file, never the actual run's PRD (e.g.
// travel-app-prd.json) — so build-info.json's story counts/metrics were
// silently computed from stale/wrong data for every external-project run,
// same root cause as the Docker mount bug, independent of it.
const ACTIVE_PRD_POINTER = path.join(DASHBOARD_ROOT, '.active-prd-path');
function resolveActivePrdPath() {
  try {
    const pointed = fs.readFileSync(ACTIVE_PRD_POINTER, 'utf8').trim();
    if (pointed) return pointed;
  } catch {
    // No pointer written yet — fall through to the legacy symlink default.
  }
  return path.join(DASHBOARD_ROOT, 'prd.json');
}

const PATHS = {
  prd: resolveActivePrdPath(),
  profiles: path.join(DASHBOARD_ROOT, 'profiles.json'),
  // profiles.json is a symlink from dashboards/ to ../agents/profiles.json,
  // but no such symlink exists for the .original floor file — read it
  // directly from its real location instead of assuming a matching symlink.
  profilesOriginal: path.join(DASHBOARD_ROOT, '..', 'agents', 'profiles.json.original'),
  logsDir: path.join(DASHBOARD_ROOT, 'logs'),
  // agentStatus/phaseCost/agentActivity are written by run-agent-orchestration.sh
  // into ITS OWN LOG_DIR, which for external-project runs (tier3-*-run.sh) IS
  // PROJECT_OUTPUT_DIR, not DASHBOARD_ROOT/logs — same root cause as the PRD
  // fix above (found live 2026-07-13). Unlike healingEvents/storyFailures/
  // guardedStepRetries/blockedStories below, these three have a working
  // in-repo default via the existing DASHBOARD_ROOT/logs symlink (confirmed:
  // orchestrations/dashboards/logs -> orchestrations/logs), so only switch to
  // PROJECT_OUTPUT_DIR when EPAM_PROJECT_OUTPUT_DIR is explicitly set —
  // PROJECT_OUTPUT_DIR's own unset-default (DASHBOARD_ROOT directly, no
  // /logs) would otherwise break the working in-repo default case.
  agentStatus: path.join(process.env.EPAM_PROJECT_OUTPUT_DIR || path.join(DASHBOARD_ROOT, 'logs'), 'agent-status.json'),
  phaseCost: path.join(process.env.EPAM_PROJECT_OUTPUT_DIR || path.join(DASHBOARD_ROOT, 'logs'), 'phase-cost.jsonl'),
  specBaseline: path.join(DASHBOARD_ROOT, 'logs', 'spec-baseline.json'),
  specSummary: path.join(DASHBOARD_ROOT, 'logs', 'spec-summary.json'),
  specLedger: path.join(DASHBOARD_ROOT, 'logs', 'spec-phase.jsonl'),
  agentActivity: path.join(process.env.EPAM_PROJECT_OUTPUT_DIR || path.join(DASHBOARD_ROOT, 'logs'), 'agent-activity.jsonl'),
  healingEvents: path.join(PROJECT_OUTPUT_DIR, 'healing-events.jsonl'),
  dynamicToolsDir: path.join(PROJECT_OUTPUT_DIR, '.epam', 'dynamic-tools'),
  storyFailures: path.join(PROJECT_OUTPUT_DIR, 'story-failures.jsonl'),
  // Prompt-eval retry guards (Step 0.5, Step 0.9, AC-review, TC-writer
  // inline/batch) — added 2026-07-13 alongside the retry-on-violation loops
  // themselves. One record per guarded call's final outcome.
  guardedStepRetries: path.join(PROJECT_OUTPUT_DIR, 'guarded-step-retries.jsonl'),
  blockedStories: path.join(PROJECT_OUTPUT_DIR, 'blocked-stories.jsonl'),
  // Persistent, ENGINE-side (this repo, not PROJECT_OUTPUT_DIR) history — the
  // per-run guardedStepRetries file above lives in the target project's own
  // output dir, which this pipeline's own "teardown" convention (rm -rf
  // OUTPUT_DIR) wipes before every fresh run. Mirrors phase-cost.jsonl's own
  // DASHBOARD_ROOT-relative convention so a violation-rate trend survives
  // across runs instead of being destroyed with the rest of the project.
  guardedStepRetriesHistory: path.join(DASHBOARD_ROOT, 'logs', 'guarded-step-retries-history.jsonl')
};

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function hashFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

function tailJsonl(filePath, limit = 5) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch {
    return [];
  }
}

function accumulateStoryStats(stories) {
  const status = {};
  const providers = {};
  const lanes = {};
  if (!Array.isArray(stories)) {
    return { status, providers, lanes, total: 0 };
  }
  stories.forEach((story) => {
    const statusKey = story?.status || 'unknown';
    status[statusKey] = (status[statusKey] || 0) + 1;
    const providerKey = story?.resolvedProvider || story?.aiProvider || 'unassigned';
    providers[providerKey] = (providers[providerKey] || 0) + 1;
    const laneKey = story?.agentGroup || 'main';
    lanes[laneKey] = (lanes[laneKey] || 0) + 1;
  });
  return { status, providers, lanes, total: stories.length };
}

function listDynamicTools(dirPath) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith('.sh'))
      .map((f) => {
        const filePath = path.join(dirPath, f);
        let purpose = '';
        try {
          const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
          purpose = (lines[1] || '').replace(/^#\s?/, '');
        } catch {
          /* leave purpose blank */
        }
        return { name: f.replace(/\.sh$/, ''), purpose };
      });
  } catch {
    return [];
  }
}

function countSelfHealLines(profileText) {
  if (typeof profileText !== 'string') return 0;
  const matches = profileText.match(/\[Self-Heal\]/g);
  return matches ? matches.length : 0;
}

// extractSelfHealRules — splits a profile's text on its "[Self-Heal] ..."
// marker into the actual individual rule strings, rather than just counting
// occurrences. Each rule runs from one marker to the next (or end of text),
// NOT to the next period — a naive per-sentence split truncates rules whose
// own text contains a period (e.g. "call process.exit()").
function extractSelfHealRules(profileText) {
  if (typeof profileText !== 'string') return [];
  const parts = profileText.split('[Self-Heal]').slice(1);
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function diffSkillNotes(profiles, profilesOriginal) {
  const current = profiles || {};
  const original = profilesOriginal || {};
  const perRole = [];
  let totalAdded = 0;
  let newRoles = 0;
  for (const role of Object.keys(current)) {
    const currentRules = extractSelfHealRules(current[role]);
    const currentCount = currentRules.length;
    if (!(role in original)) {
      if (currentCount > 0) {
        perRole.push({ role, added: currentCount, isNewRole: true, addedRules: currentRules });
        totalAdded += currentCount;
      }
      newRoles += 1;
      continue;
    }
    const originalRules = new Set(extractSelfHealRules(original[role]));
    const newRules = currentRules.filter((r) => !originalRules.has(r));
    if (newRules.length > 0) {
      perRole.push({ role, added: newRules.length, isNewRole: false, addedRules: newRules });
      totalAdded += newRules.length;
    }
  }
  return { perRole, totalAdded, newRoles };
}

function summarizeHealingEvents(events) {
  const byTarget = {};
  const healingBroken = [];
  const perStory = {};
  const cycles = [];
  let patchesApplied = 0;
  let profileUpdates = 0;
  let analystCycles = 0;

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.event === 'HEALING_BROKEN') {
      healingBroken.push(e);
      continue;
    }
    if (!('target' in e)) continue;
    analystCycles += 1;
    const target = e.target || 'none';
    byTarget[target] = (byTarget[target] || 0) + 1;
    patchesApplied += Number(e.patches_applied) || 0;
    if (e.profile_updated === true || e.profile_updated === 'true') profileUpdates += 1;
    const sid = e.story_id || 'unknown';
    perStory[sid] = (perStory[sid] || 0) + 1;
    cycles.push(e);
  }

  return {
    analystCycles,
    byTarget,
    patchesApplied,
    profileUpdates,
    healingBrokenCount: healingBroken.length,
    healingBrokenRecent: healingBroken.slice(-10),
    storiesHealed: Object.keys(perStory).length,
    perStory,
    recentCycles: cycles.slice(-15)
  };
}

// Prompt-eval retry guards — Step 0.5/0.9/AC-review/TC-writer each log one
// record per guarded call's FINAL outcome (pass/reverted/blocked) plus how
// many of the 3 allowed attempts it took. "% evaluated" here means the share
// of guarded calls that actually violated the deterministic check at least
// once (attempts > 1) — i.e. the eval genuinely caught and acted on
// something, not just a rubber-stamped first attempt.
function summarizeGuardedStepRetries(events) {
  const byStep = {};
  let total = 0;
  let evaluated = 0; // attempts > 1: the deterministic check fired at least once
  let passed = 0;
  let reverted = 0;
  let blocked = 0;

  for (const e of events) {
    if (!e || typeof e !== 'object' || !e.step) continue;
    total += 1;
    const attempts = Number(e.attempts) || 1;
    if (attempts > 1) evaluated += 1;
    if (e.outcome === 'pass') passed += 1;
    else if (e.outcome === 'reverted') reverted += 1;
    else if (e.outcome === 'blocked') blocked += 1;

    const step = e.step;
    if (!byStep[step]) byStep[step] = { total: 0, evaluated: 0, passed: 0, reverted: 0, blocked: 0 };
    byStep[step].total += 1;
    if (attempts > 1) byStep[step].evaluated += 1;
    if (e.outcome === 'pass') byStep[step].passed += 1;
    else if (e.outcome === 'reverted') byStep[step].reverted += 1;
    else if (e.outcome === 'blocked') byStep[step].blocked += 1;
  }

  return {
    total,
    evaluated,
    evaluatedPct: total ? Math.round((evaluated / total) * 100) : 0,
    passed,
    reverted,
    blocked,
    byStep,
    recent: events.slice(-15)
  };
}

// Cross-run trend: groups the persistent history file's records by runId so
// "is this prompt getting more or less effective over time" can actually be
// answered (the per-run summary above only ever sees the CURRENT run's
// records, wiped along with the rest of the project on the next teardown).
// One row per (runId, step) pair, newest run first, capped to the most
// recent MAX_RUNS distinct runIds — same bounded-read spirit as tailJsonl.
const MAX_HISTORY_RUNS = 20;

function summarizeGuardedStepHistory(events) {
  const byRunStep = new Map(); // `${runId} ${step}` -> row
  const runOrder = []; // first-seen order of runId, used to derive recency
  const violationTypesByStep = {};

  for (const e of events) {
    if (!e || typeof e !== 'object' || !e.step || !e.runId) continue;
    const runId = e.runId;
    if (!runOrder.includes(runId)) runOrder.push(runId);

    const key = `${runId} ${e.step}`;
    if (!byRunStep.has(key)) {
      byRunStep.set(key, {
        runId,
        promptVersion: e.promptVersion || 'unknown',
        timestamp: e.timestamp || null,
        step: e.step,
        total: 0,
        evaluated: 0,
        passed: 0,
        reverted: 0,
        blocked: 0
      });
    }
    const row = byRunStep.get(key);
    row.total += 1;
    const attempts = Number(e.attempts) || 1;
    if (attempts > 1) row.evaluated += 1;
    if (e.outcome === 'pass') row.passed += 1;
    else if (e.outcome === 'reverted') row.reverted += 1;
    else if (e.outcome === 'blocked') row.blocked += 1;
    // Always take the LATEST timestamp seen for this (runId, step) pair so
    // the row sorts by when the run actually happened, not first-seen order.
    if (e.timestamp && (!row.timestamp || e.timestamp > row.timestamp)) row.timestamp = e.timestamp;
    if (e.promptVersion) row.promptVersion = e.promptVersion;

    if (Array.isArray(e.violationTypes) && e.violationTypes.length) {
      if (!violationTypesByStep[e.step]) violationTypesByStep[e.step] = {};
      for (const vt of e.violationTypes) {
        violationTypesByStep[e.step][vt] = (violationTypesByStep[e.step][vt] || 0) + 1;
      }
    }
  }

  // Most-recent-run-first: sort runIds by the latest timestamp seen across
  // any of their rows, then keep only the most recent MAX_HISTORY_RUNS.
  const latestTsByRun = {};
  for (const row of byRunStep.values()) {
    if (!latestTsByRun[row.runId] || (row.timestamp && row.timestamp > latestTsByRun[row.runId])) {
      latestTsByRun[row.runId] = row.timestamp;
    }
  }
  const recentRunIds = new Set(
    [...runOrder]
      .sort((a, b) => String(latestTsByRun[b] || '').localeCompare(String(latestTsByRun[a] || '')))
      .slice(0, MAX_HISTORY_RUNS)
  );

  const rows = [...byRunStep.values()]
    .filter((row) => recentRunIds.has(row.runId))
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

  return {
    rows,
    violationTypesByStep,
    distinctRunsTracked: runOrder.length
  };
}

function deriveSpecCoverage(stories) {
  if (!Array.isArray(stories) || !stories.length) {
    return { total: 0, completed: 0 };
  }
  const specStories = stories.filter((story) => story && story.specification);
  const completed = specStories.filter(
    (story) => story.specification?.status === 'completed'
  ).length;
  return { total: specStories.length, completed };
}

// storyCommits — "what did each story actually produce" (real git commits,
// not a status label). Each completed story's implementation loop commits
// with the message "story: complete <id> (<N> file(s))" (see
// run-agent-orchestration.sh's post-story commit step) — a real, verifiable
// artifact, distinct from PRD status which is just the pipeline's own
// bookkeeping. Reads the WHOLE commit log once (one git process) and matches
// subjects locally rather than shelling out per story.
function computeStoryCommits(prd, projectRoot) {
  const result = {};
  if (!projectRoot || !fs.existsSync(path.join(projectRoot, '.git'))) return result;

  let branch = null;
  try {
    branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim() || null;
  } catch {
    // Detached HEAD or git unavailable — leave branch null, not fatal.
  }

  let log = '';
  try {
    // One line per commit (no --name-only — the commit SUBJECT itself already
    // states the file count, "story: complete <id> (<N> file(s))", written by
    // run-agent-orchestration.sh's post-story commit step, so there's no need
    // to parse a separate per-commit file list at all).
    log = execFileSync(
      'git',
      ['log', '--format=%H\x1f%cI\x1f%s'],
      { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch {
    return result; // Not a git repo, or git not installed — no commits to show.
  }

  const commits = log.split('\n').filter(Boolean).map((line) => {
    const [sha, isoDate, ...rest] = line.split('\x1f');
    return { sha, isoDate, subject: rest.join('\x1f') };
  });
  const storyIds = (prd.stories || []).map((s) => s.id).filter(Boolean);

  for (const id of storyIds) {
    const marker = `story: complete ${id} (`;
    // Newest-first log order — first match wins.
    const hit = commits.find((c) => c.subject && c.subject.startsWith(marker));
    if (!hit) continue;
    const fileCountMatch = hit.subject.match(/\((\d+) file/);
    result[id] = {
      sha: hit.sha,
      shortSha: (hit.sha || '').slice(0, 7),
      timestamp: hit.isoDate || null,
      fileCount: fileCountMatch ? parseInt(fileCountMatch[1], 10) : null,
      branch
    };
  }
  return result;
}

function loadSnapshot() {
  const prd = safeReadJson(PATHS.prd, { stories: [] });
  const agentStatus = safeReadJson(PATHS.agentStatus, {});
  const profiles = safeReadJson(PATHS.profiles, {});
  const profilesOriginal = safeReadJson(PATHS.profilesOriginal, null);
  const specSummary = safeReadJson(PATHS.specSummary, null);
  const stats = accumulateStoryStats(prd.stories);
  const specCoverage = deriveSpecCoverage(prd.stories);
  const healingEvents = tailJsonl(PATHS.healingEvents, 9999);
  const healingSummary = summarizeHealingEvents(healingEvents);
  const skillNotesDiff = diffSkillNotes(profiles, profilesOriginal);
  const dynamicTools = listDynamicTools(PATHS.dynamicToolsDir);
  const storyFailures = tailJsonl(PATHS.storyFailures, 9999);
  const guardedStepRetryEvents = tailJsonl(PATHS.guardedStepRetries, 9999);
  const guardedStepRetries = summarizeGuardedStepRetries(guardedStepRetryEvents);
  const blockedStories = tailJsonl(PATHS.blockedStories, 9999);
  const guardedStepHistoryEvents = tailJsonl(PATHS.guardedStepRetriesHistory, 2000);
  const guardedStepHistory = summarizeGuardedStepHistory(guardedStepHistoryEvents);
  const storyCommitsProjectRoot = prd?.project?.outputDir || PROJECT_OUTPUT_DIR;
  const storyCommits = computeStoryCommits(prd, storyCommitsProjectRoot);

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      prd: {
        path: path.relative(DASHBOARD_ROOT, PATHS.prd) || PATHS.prd,
        hash: hashFile(PATHS.prd),
        storyCount: stats.total
      },
      profiles: {
        path: 'orchestrations/agents/profiles.json',
        hash: hashFile(PATHS.profiles),
        profileCount: Object.keys(profiles || {}).length
      },
      agentStatus: {
        path: path.relative(DASHBOARD_ROOT, PATHS.agentStatus) || PATHS.agentStatus,
        hash: hashFile(PATHS.agentStatus),
        lastUpdated: agentStatus?.lastUpdated || null,
        currentPhase: agentStatus?.currentPhase || null
      },
      phaseCost: {
        path: path.relative(DASHBOARD_ROOT, PATHS.phaseCost) || PATHS.phaseCost,
        hash: hashFile(PATHS.phaseCost),
        sample: tailJsonl(PATHS.phaseCost, 5)
      },
      specification: {
        baselineHash: hashFile(PATHS.specBaseline),
        ledgerHash: hashFile(PATHS.specLedger),
        latestRun: specSummary?.runId || null,
        phase: specSummary?.phase || null,
        summaryHash: hashFile(PATHS.specSummary)
      }
    },
    metrics: {
      storyCount: stats.total,
      status: stats.status,
      providers: stats.providers,
      lanes: stats.lanes,
      activeLanes: Object.keys(agentStatus?.lanes || {}),
      recentEvents: (agentStatus?.events || []).slice(-5),
      specification: specCoverage,
      specRecent: tailJsonl(PATHS.specLedger, 5),
      agentActivity: {
        hash: hashFile(PATHS.agentActivity),
        total: tailJsonl(PATHS.agentActivity, 9999).length,
        recent: tailJsonl(PATHS.agentActivity, 10)
      },
      selfHealing: {
        projectOutputDir: PROJECT_OUTPUT_DIR,
        healing: healingSummary,
        skillNotes: skillNotesDiff,
        dynamicTools,
        storyFailureEvents: storyFailures.length
      },
      promptEvals: {
        ...guardedStepRetries,
        blockedStoriesCount: blockedStories.length,
        blockedStoriesRecent: blockedStories.slice(-10),
        history: guardedStepHistory
      },
      storyCommits
    }
  };
}

module.exports = {
  computeStoryCommits,
  PATHS,
  loadSnapshot,
  summarizeGuardedStepHistory
};
