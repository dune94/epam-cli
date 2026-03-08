#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
function parseArgs(list) {
  const parsed = { phase: null, dryRun: false };
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--phase' && list[i + 1]) {
      parsed.phase = list[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
  }
  return parsed;
}

function usage() {
  console.log(`Usage: npm run spec-mode -- --phase <phase>
Options:
  --phase <id>   Phase to run specification mode against (required)
  --dry-run      Evaluate coordinator assignments without applying PRD changes
`);
}

async function run() {
  const opts = parseArgs(args);
  if (opts.help || !opts.phase) {
    usage();
    if (!opts.phase) process.exitCode = 1;
    return;
  }

  const scriptDir = __dirname;
  const automationDir = path.resolve(scriptDir, '..');
  const prdPath = process.env.PRD_FILE
    ? path.resolve(process.env.PRD_FILE)
    : path.join(automationDir, 'prd.json');
  const logDir = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.join(automationDir, 'logs');
  const claudeCmd = process.env.CLAUDE_CMD || 'claude';

  if (!fs.existsSync(prdPath)) {
    console.error('spec-mode-runner: prd.json not found at', prdPath);
    process.exit(1);
  }
  fs.mkdirSync(logDir, { recursive: true });

  const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
  const phaseStories = Array.isArray(prd.implementationOrder?.[opts.phase])
    ? prd.implementationOrder[opts.phase]
    : [];
  if (!phaseStories.length) {
    console.log(`spec-mode: phase ${opts.phase} has no stories; skipping.`);
    return;
  }

  const storiesById = new Map();
  (Array.isArray(prd.stories) ? prd.stories : []).forEach((story) => {
    if (story && story.id) storiesById.set(story.id, story);
  });
  const stories = phaseStories
    .map((id) => storiesById.get(id))
    .filter((story) => story && story.completed !== true);
  if (!stories.length) {
    console.log(`spec-mode: phase ${opts.phase} has no pending stories.`);
    return;
  }

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  const specRunDir = path.join(logDir, 'spec-runs', runId);
  fs.mkdirSync(specRunDir, { recursive: true });
  const baselinePath = path.join(specRunDir, 'prd.before.json');
  fs.writeFileSync(baselinePath, JSON.stringify(prd, null, 2));
  const baselineLatest = path.join(logDir, 'spec-baseline.json');
  fs.copyFileSync(baselinePath, baselineLatest);

  const pointerPath = path.join(logDir, 'spec-run-latest.json');
  fs.writeFileSync(
    pointerPath,
    JSON.stringify(
      {
        runId,
        phase: opts.phase,
        baseline: path.relative(logDir, baselinePath),
        baselineCopy: 'spec-baseline.json',
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  const storiesPayload = JSON.stringify(
    stories.map((story) => ({
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      technicalNotes: story.technicalNotes,
      agentRole: story.agentRole,
      agentGroup: story.agentGroup,
      dependencies: story.dependencies || [],
      spec: story.specification || null
    })),
    null,
    2
  );

  const coordinatorPrompt = `You are the EPAM CLI specification coordinator agent for phase ${opts.phase}.

Decide which specification agents (openspec and/or speckit) should run for each story below. Consider dependencies, missing acceptance criteria, and technical risks. Respond with JSON between <SPEC_ASSIGNMENTS> and </SPEC_ASSIGNMENTS> using this schema:
[
  {"storyId":"EPAM-123","agents":["openspec","speckit"],"notes":"reason","priority":"high"}
]
If a story does not need spec work, provide an empty agents array.

Stories JSON:
${storiesPayload}

<SPEC_ASSIGNMENTS>
</SPEC_ASSIGNMENTS>`;

  let assignmentsOutput = '';
  try {
    assignmentsOutput = await runClaude(
      claudeCmd,
      coordinatorPrompt,
      path.join(logDir, `spec-coordinator-${opts.phase}.log`)
    );
  } catch (error) {
    console.warn('spec-mode: coordinator failed, falling back to default agent pair:', error.message);
  }
  const assignments = extractTaggedJson(assignmentsOutput, 'SPEC_ASSIGNMENTS');
  const assignmentsMap = buildAssignments(assignments, stories, runId);

  if (opts.dryRun) {
    console.log(JSON.stringify(Object.fromEntries(assignmentsMap), null, 2));
    return;
  }

  const specLogPath = path.join(logDir, 'spec-phase.jsonl');
  const summary = {
    runId,
    phase: opts.phase,
    startedAt: new Date().toISOString(),
    stories: [],
    stats: { acceptanceUpdated: 0, splits: 0, agents: {} }
  };
  const newStories = [];

  for (const story of stories) {
    const assigned = assignmentsMap.get(story.id);
    if (!assigned || !assigned.agents.length) {
      continue;
    }
    const agentRuns = await Promise.all(
      assigned.agents.map((agent) => runSpecAgent({ claudeCmd, agent, story, phase: opts.phase, runId, logDir }))
    );
    const appliedAgents = [];
    for (const run of agentRuns) {
      if (!run || !run.payload) continue;
      const before = captureStorySnapshot(story);
      const { payload } = run;
      payload.runId = runId;
      const hasChanges = applySpecChanges(story, payload, newStories, prd, opts.phase, runId);
      appendJsonl(specLogPath, {
        timestamp: new Date().toISOString(),
        phase_id: opts.phase,
        run_id: runId,
        story_id: story.id,
        agent: payload.agent || run.agent,
        before,
        after: captureStorySnapshot(story),
        notes: payload.notes || '',
        splitStories: payload.splitStories || [],
        acceptanceChanged: hasChanges.acceptanceChanged
      });
      appliedAgents.push(payload.agent || run.agent);
      if (hasChanges.acceptanceChanged) {
        summary.stats.acceptanceUpdated += 1;
      }
      summary.stats.splits += hasChanges.splitCount;
      summary.stats.agents[payload.agent || run.agent] =
        (summary.stats.agents[payload.agent || run.agent] || 0) + 1;
    }
    const specStatus = appliedAgents.length ? 'completed' : 'assigned';
    story.specification = {
      ...(story.specification || {}),
      runId,
      assignedAgents: assigned.agents,
      coordinatorNotes: assigned.notes,
      status: specStatus,
      updatedAt: new Date().toISOString(),
      appliedAgents
    };
    summary.stories.push({
      storyId: story.id,
      assignedAgents: assigned.agents,
      appliedAgents,
      notes: assigned.notes,
      acceptanceUpdated: appliedAgents.length > 0,
      status: specStatus
    });
  }

  if (newStories.length) {
    const parentInsertOffsets = {};
    for (const insert of newStories) {
      prd.stories.push(insert.story);
      const order = prd.implementationOrder?.[opts.phase];
      if (Array.isArray(order)) {
        const parentIndex = order.indexOf(insert.parentId);
        const offset = parentInsertOffsets[insert.parentId] || 0;
        const targetIndex = parentIndex === -1 ? order.length : parentIndex + 1 + offset;
        order.splice(targetIndex, 0, insert.story.id);
        parentInsertOffsets[insert.parentId] = offset + 1;
      }
    }
  }

  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  summary.completedAt = new Date().toISOString();
  summary.storyCount = summary.stories.length;
  fs.writeFileSync(path.join(specRunDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(logDir, 'spec-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`spec-mode: completed for phase ${opts.phase} (run ${runId})`);
}

function buildAssignments(assignments, stories, runId) {
  const map = new Map();
  const fallback = ['openspec', 'speckit'];
  const storyIds = new Set(stories.map((s) => s.id));
  if (Array.isArray(assignments)) {
    assignments.forEach((entry) => {
      if (!entry || !storyIds.has(entry.storyId)) return;
      const agents = Array.isArray(entry.agents) && entry.agents.length ? entry.agents : [];
      map.set(entry.storyId, {
        storyId: entry.storyId,
        agents,
        notes: entry.notes || '',
        priority: entry.priority || 'normal',
        runId
      });
    });
  }
  stories.forEach((story) => {
    if (map.has(story.id)) return;
    map.set(story.id, { storyId: story.id, agents: fallback, notes: '', runId });
  });
  return map;
}

function captureStorySnapshot(story) {
  return {
    acceptanceCriteria: Array.isArray(story.acceptanceCriteria)
      ? [...story.acceptanceCriteria]
      : [],
    description: story.description,
    title: story.title,
    technicalNotes: story.technicalNotes || null
  };
}

function applySpecChanges(story, payload, newStories, prd, phaseId, runId) {
  const result = { acceptanceChanged: false, splitCount: 0 };
  if (Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length) {
    const before = JSON.stringify(story.acceptanceCriteria || []);
    const after = JSON.stringify(payload.acceptanceCriteria);
    if (before !== after) {
      story.acceptanceCriteria = payload.acceptanceCriteria;
      result.acceptanceChanged = true;
    }
  }
  if (typeof payload.description === 'string' && payload.description.trim()) {
    story.description = payload.description.trim();
  }
  if (payload.title && typeof payload.title === 'string') {
    story.title = payload.title.trim();
  }
  if (payload.technicalNotes && typeof payload.technicalNotes === 'object') {
    story.technicalNotes = payload.technicalNotes;
  }
  if (Array.isArray(payload.splitStories) && payload.splitStories.length) {
    payload.splitStories.forEach((split, idx) => {
      if (!split || typeof split !== 'object') return;
      const baseId = split.id && typeof split.id === 'string' ? split.id : `${story.id}-SPEC-${idx + 1}`;
      let newId = baseId;
      let suffix = 1;
      while (prd.stories.some((s) => s.id === newId)) {
        newId = `${baseId}-${suffix}`;
        suffix += 1;
      }
      const newStory = JSON.parse(JSON.stringify(story));
      newStory.id = newId;
      newStory.title = split.title || `${story.title} (Spec Split ${idx + 1})`;
      newStory.description = split.description || story.description;
      newStory.acceptanceCriteria = Array.isArray(split.acceptanceCriteria) && split.acceptanceCriteria.length
        ? [...split.acceptanceCriteria]
        : Array.isArray(story.acceptanceCriteria)
          ? [...story.acceptanceCriteria]
          : [];
      newStory.status = 'pending';
      newStory.completed = false;
      newStory.dependencies = Array.isArray(split.dependencies) ? split.dependencies : [];
      newStory.specification = {
        createdFrom: story.id,
        createdAt: new Date().toISOString(),
        runId
      };
      newStories.push({ parentId: story.id, story: newStory, phase: phaseId });
      result.splitCount += 1;
    });
  }
  return result;
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function extractTaggedJson(text, tag) {
  if (!text) return null;
  const regex = new RegExp(`<${tag}>([\s\S]*?)</${tag}>`);
  const match = regex.exec(text);
  if (!match) return null;
  const jsonText = match[1].trim();
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    console.warn(`Failed to parse JSON for tag ${tag}:`, err.message);
    return null;
  }
}

function runClaude(cmd, prompt, logPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const proc = spawn(cmd, ['--dangerously-skip-permissions'], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => reject(error));
    proc.on('close', (code) => {
      const output = `${stdout}\n${stderr}`.trim();
      fs.writeFileSync(logPath, `# Prompt\n${prompt}\n\n# Output\n${output}\n`);
      if (code !== 0) {
        return reject(new Error(`claude exited with code ${code}`));
      }
      resolve(output);
    });
    proc.stdin.end(prompt);
  });
}

async function runSpecAgent({ claudeCmd, agent, story, phase, runId, logDir }) {
  const storyPayload = JSON.stringify({
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    technicalNotes: story.technicalNotes,
    agentRole: story.agentRole,
    agentGroup: story.agentGroup,
    dependencies: story.dependencies || []
  }, null, 2);
  const prompt = `You are the ${agent} specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.

Generate refined acceptance criteria, optionally updated title/description, and optional split stories. Output JSON only between <SPEC_AGENT> tags using this schema:
{
  "storyId":"${story.id}",
  "agent":"${agent}",
  "notes":"context",
  "acceptanceCriteria":["..."],
  "description":"...",
  "title":"...",
  "splitStories":[{"id":"optional","title":"...","description":"...","acceptanceCriteria":["..."]}]
}
Use existing text when no change is needed.
Story context:
${storyPayload}

<SPEC_AGENT>`;
  try {
    const output = await runClaude(claudeCmd, prompt, path.join(logDir, `${story.id}-${agent}-spec.log`));
    const payload = extractTaggedJson(output, 'SPEC_AGENT');
    return { agent, payload };
  } catch (error) {
    console.warn(`spec-mode: ${agent} run failed for ${story.id}:`, error.message);
    return null;
  }
}

run().catch((err) => {
  console.error('spec-mode-runner failed:', err);
  process.exit(1);
});
