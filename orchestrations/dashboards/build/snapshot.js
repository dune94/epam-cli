const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
const PATHS = {
  prd: path.join(DASHBOARD_ROOT, 'prd.json'),
  profiles: path.join(DASHBOARD_ROOT, 'profiles.json'),
  // profiles.json is a symlink from dashboards/ to ../agents/profiles.json,
  // but no such symlink exists for the .original floor file — read it
  // directly from its real location instead of assuming a matching symlink.
  profilesOriginal: path.join(DASHBOARD_ROOT, '..', 'agents', 'profiles.json.original'),
  logsDir: path.join(DASHBOARD_ROOT, 'logs'),
  agentStatus: path.join(DASHBOARD_ROOT, 'logs', 'agent-status.json'),
  phaseCost: path.join(DASHBOARD_ROOT, 'logs', 'phase-cost.jsonl'),
  specBaseline: path.join(DASHBOARD_ROOT, 'logs', 'spec-baseline.json'),
  specSummary: path.join(DASHBOARD_ROOT, 'logs', 'spec-summary.json'),
  specLedger: path.join(DASHBOARD_ROOT, 'logs', 'spec-phase.jsonl'),
  agentActivity: path.join(DASHBOARD_ROOT, 'logs', 'agent-activity.jsonl'),
  healingEvents: path.join(PROJECT_OUTPUT_DIR, 'healing-events.jsonl'),
  dynamicToolsDir: path.join(PROJECT_OUTPUT_DIR, '.epam', 'dynamic-tools'),
  storyFailures: path.join(PROJECT_OUTPUT_DIR, 'story-failures.jsonl'),
  // Prompt-eval retry guards (Step 0.5, Step 0.9, AC-review, TC-writer
  // inline/batch) — added 2026-07-13 alongside the retry-on-violation loops
  // themselves. One record per guarded call's final outcome.
  guardedStepRetries: path.join(PROJECT_OUTPUT_DIR, 'guarded-step-retries.jsonl'),
  blockedStories: path.join(PROJECT_OUTPUT_DIR, 'blocked-stories.jsonl')
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

function diffSkillNotes(profiles, profilesOriginal) {
  const current = profiles || {};
  const original = profilesOriginal || {};
  const perRole = [];
  let totalAdded = 0;
  let newRoles = 0;
  for (const role of Object.keys(current)) {
    const currentCount = countSelfHealLines(current[role]);
    if (!(role in original)) {
      if (currentCount > 0) {
        perRole.push({ role, added: currentCount, isNewRole: true });
        totalAdded += currentCount;
      }
      newRoles += 1;
      continue;
    }
    const originalCount = countSelfHealLines(original[role]);
    const added = currentCount - originalCount;
    if (added > 0) {
      perRole.push({ role, added, isNewRole: false });
      totalAdded += added;
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

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      prd: {
        path: 'orchestrations/prd.json',
        hash: hashFile(PATHS.prd),
        storyCount: stats.total
      },
      profiles: {
        path: 'orchestrations/agents/profiles.json',
        hash: hashFile(PATHS.profiles),
        profileCount: Object.keys(profiles || {}).length
      },
      agentStatus: {
        path: 'orchestrations/logs/agent-status.json',
        hash: hashFile(PATHS.agentStatus),
        lastUpdated: agentStatus?.lastUpdated || null,
        currentPhase: agentStatus?.currentPhase || null
      },
      phaseCost: {
        path: 'orchestrations/logs/phase-cost.jsonl',
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
        blockedStoriesRecent: blockedStories.slice(-10)
      }
    }
  };
}

module.exports = {
  PATHS,
  loadSnapshot
};
