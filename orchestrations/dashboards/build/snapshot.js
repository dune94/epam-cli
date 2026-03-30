const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DASHBOARD_ROOT = path.join(__dirname, '..');
const PATHS = {
  prd: path.join(DASHBOARD_ROOT, 'prd.json'),
  profiles: path.join(DASHBOARD_ROOT, 'profiles.json'),
  logsDir: path.join(DASHBOARD_ROOT, 'logs'),
  agentStatus: path.join(DASHBOARD_ROOT, 'logs', 'agent-status.json'),
  phaseCost: path.join(DASHBOARD_ROOT, 'logs', 'phase-cost.jsonl'),
  specBaseline: path.join(DASHBOARD_ROOT, 'logs', 'spec-baseline.json'),
  specSummary: path.join(DASHBOARD_ROOT, 'logs', 'spec-summary.json'),
  specLedger: path.join(DASHBOARD_ROOT, 'logs', 'spec-phase.jsonl'),
  agentActivity: path.join(DASHBOARD_ROOT, 'logs', 'agent-activity.jsonl')
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
  const specSummary = safeReadJson(PATHS.specSummary, null);
  const stats = accumulateStoryStats(prd.stories);
  const specCoverage = deriveSpecCoverage(prd.stories);

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
      }
  };
}

module.exports = {
  PATHS,
  loadSnapshot
};
