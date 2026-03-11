#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spec-mode-runner.js — Collaborative specification elaboration pipeline
//
// Architecture:
//   coordinator  →  assigns agents per story
//   openspec     →  elaborates AC, proposes splits, adds technical depth
//   speckit      →  reviews openspec output, adds testability/security/edge-case
//                   criteria, flags gaps, may refine splits
//   coordinator  →  final review pass with verdict + quality score
//
// Agent collaboration is SEQUENTIAL, not parallel:
//   openspec runs first per story, then speckit receives openspec's output
//   and builds on it. Each agent's contribution is tracked independently.
// ─────────────────────────────────────────────────────────────────────────────
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

  // ── Step 1: Coordinator assigns agents ─────────────────────────────────
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

Decide which specification agents should run for each story below.
Available agents and their roles:
  - openspec: Elaborates requirements — refines AC, proposes story splits, adds technical depth
  - speckit: Reviews & hardens — adds testability criteria, security checks, edge cases, flags gaps

Agent collaboration model:
  - If both are assigned, openspec runs FIRST, then speckit reviews openspec's output
  - Assign both for complex/critical stories
  - Assign only openspec for simple elaboration
  - Assign only speckit for stories that just need test/security hardening

Respond with JSON between <SPEC_ASSIGNMENTS> and </SPEC_ASSIGNMENTS> using this schema:
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

  // ── Step 2: Sequential agent collaboration per story ───────────────────
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

    const agentContributions = [];
    const appliedAgents = [];
    let openspecPayload = null;

    // Run agents SEQUENTIALLY: openspec first, then speckit with openspec's output
    for (const agent of assigned.agents) {
      const beforeSnapshot = captureStorySnapshot(story);

      let agentResult;
      if (agent === 'speckit' && openspecPayload) {
        // Speckit receives openspec's output for collaborative review
        agentResult = await runSpeckitReview({
          claudeCmd, story, openspecOutput: openspecPayload,
          phase: opts.phase, runId, logDir
        });
      } else {
        agentResult = await runSpecAgent({
          claudeCmd, agent, story, phase: opts.phase, runId, logDir
        });
      }

      if (!agentResult || !agentResult.payload) {
        agentContributions.push({
          agent,
          applied: false,
          notes: 'Agent output could not be parsed',
          acceptanceChanged: false,
          splitCount: 0,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      const { payload } = agentResult;

      // Track openspec output so speckit can use it
      if (agent === 'openspec') {
        openspecPayload = payload;
      }

      payload.runId = runId;
      const changes = applySpecChanges(story, payload, newStories, prd, opts.phase, runId);

      const afterSnapshot = captureStorySnapshot(story);

      // Log each agent's contribution as a separate JSONL entry
      appendJsonl(specLogPath, {
        timestamp: new Date().toISOString(),
        phase_id: opts.phase,
        run_id: runId,
        story_id: story.id,
        agent,
        before: beforeSnapshot,
        after: afterSnapshot,
        notes: payload.notes || '',
        splitStories: payload.splitStories || [],
        acceptanceChanged: changes.acceptanceChanged
      });

      appliedAgents.push(agent);

      // Build contribution record with actual diff data
      const contrib = {
        agent,
        applied: true,
        notes: payload.notes || '',
        acceptanceChanged: changes.acceptanceChanged,
        splitCount: changes.splitCount,
        timestamp: new Date().toISOString()
      };
      if (changes.acceptanceChanged) {
        contrib.acBefore = beforeSnapshot.acceptanceCriteria;
        contrib.acAfter = afterSnapshot.acceptanceCriteria;
        contrib.acAdded = afterSnapshot.acceptanceCriteria.filter(
          ac => !beforeSnapshot.acceptanceCriteria.includes(ac)
        );
        contrib.acRemoved = beforeSnapshot.acceptanceCriteria.filter(
          ac => !afterSnapshot.acceptanceCriteria.includes(ac)
        );
        summary.stats.acceptanceUpdated += 1;
      }
      if (changes.splitCount > 0) {
        contrib.splitIds = (payload.splitStories || []).map(
          (s, i) => s.id || `${story.id}-SPEC-${i + 1}`
        );
      }
      agentContributions.push(contrib);

      summary.stats.splits += changes.splitCount;
      summary.stats.agents[agent] = (summary.stats.agents[agent] || 0) + 1;
    }

    const specStatus = appliedAgents.length ? 'completed' : 'assigned';
    story.specification = {
      ...(story.specification || {}),
      runId,
      assignedAgents: assigned.agents,
      coordinatorNotes: assigned.notes,
      status: specStatus,
      updatedAt: new Date().toISOString(),
      appliedAgents,
      agentContributions
    };
    summary.stories.push({
      storyId: story.id,
      assignedAgents: assigned.agents,
      appliedAgents,
      notes: assigned.notes,
      acceptanceUpdated: appliedAgents.length > 0,
      status: specStatus,
      agentContributions
    });
  }

  // ── Step 3: Insert split stories into PRD ──────────────────────────────
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

  // ── Step 4: Coordinator review pass ────────────────────────────────────
  const specifiedStories = stories.filter(
    s => s.specification && s.specification.appliedAgents && s.specification.appliedAgents.length > 0
  );
  if (specifiedStories.length > 0) {
    const reviewPayload = JSON.stringify(specifiedStories.map(s => ({
      id: s.id,
      title: s.title,
      acceptanceCriteria: s.acceptanceCriteria,
      specification: s.specification,
      splitChildren: (prd.stories || [])
        .filter(c => c.specification && c.specification.createdFrom === s.id)
        .map(c => ({ id: c.id, title: c.title, acceptanceCriteria: c.acceptanceCriteria }))
    })), null, 2);

    const reviewPrompt = `You are the EPAM CLI specification coordinator reviewing the completed spec outputs for phase ${opts.phase}.

Each story was processed by a sequential agent pipeline:
  1. openspec elaborated requirements (AC refinement, story splits, technical depth)
  2. speckit reviewed openspec's output (testability, security, edge cases, gap analysis)

For each story, evaluate the quality of the collaborative spec work:
1. Did both agents add meaningful, non-overlapping value?
2. Are the acceptance criteria complete, testable, and non-overlapping?
3. Are story splits logical and properly scoped?
4. Flag any story needing human review.

Respond with JSON between <SPEC_REVIEW> and </SPEC_REVIEW> using this schema:
[
  {"storyId":"REM-xxx","verdict":"approved|needs_review","reviewNotes":"coordinator observations","qualityScore":0.0-1.0,"flags":[]}
]

Stories to review:
${reviewPayload}

<SPEC_REVIEW>
</SPEC_REVIEW>`;

    let reviewOutput = '';
    try {
      reviewOutput = await runClaude(
        claudeCmd,
        reviewPrompt,
        path.join(logDir, `spec-coordinator-review-${opts.phase}.log`)
      );
    } catch (error) {
      console.warn('spec-mode: coordinator review failed:', error.message);
    }
    const reviews = extractTaggedJson(reviewOutput, 'SPEC_REVIEW');
    if (Array.isArray(reviews)) {
      const reviewMap = new Map();
      reviews.forEach(r => { if (r && r.storyId) reviewMap.set(r.storyId, r); });
      for (const story of specifiedStories) {
        const review = reviewMap.get(story.id);
        if (review) {
          story.specification.coordinatorReview = {
            verdict: review.verdict || 'approved',
            reviewNotes: review.reviewNotes || '',
            qualityScore: typeof review.qualityScore === 'number' ? review.qualityScore : null,
            flags: Array.isArray(review.flags) ? review.flags : [],
            reviewedAt: new Date().toISOString()
          };
          const summaryEntry = summary.stories.find(s => s.storyId === story.id);
          if (summaryEntry) {
            summaryEntry.coordinatorReview = story.specification.coordinatorReview;
          }
        }
      }
      summary.stats.coordinatorReviewCompleted = true;
      summary.stats.approved = reviews.filter(r => r.verdict === 'approved').length;
      summary.stats.needsReview = reviews.filter(r => r.verdict === 'needs_review').length;
    }
  }

  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  summary.completedAt = new Date().toISOString();
  summary.storyCount = summary.stories.length;
  fs.writeFileSync(path.join(specRunDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(logDir, 'spec-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`spec-mode: completed for phase ${opts.phase} (run ${runId})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent prompt builders
// ─────────────────────────────────────────────────────────────────────────────

// openspec: first-pass elaboration (unchanged from before)
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

// speckit: second-pass review of openspec's output — the collaboration point
async function runSpeckitReview({ claudeCmd, story, openspecOutput, phase, runId, logDir }) {
  const prompt = `You are the speckit specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.

You are reviewing and building on the openspec agent's output for this story.
Your role is COLLABORATIVE — you are NOT starting from scratch. Instead:
1. Review openspec's proposed acceptance criteria for testability and completeness
2. Add missing edge-case, error-handling, security, and accessibility criteria
3. Flag any AC that are vague, untestable, or overlapping
4. If openspec proposed story splits, validate the decomposition and refine AC per split
5. Do NOT remove or duplicate openspec's good work — build on it

OPENSPEC'S OUTPUT (your input to review):
${JSON.stringify(openspecOutput, null, 2)}

ORIGINAL STORY CONTEXT:
${JSON.stringify({
  id: story.id,
  title: story.title,
  description: story.description,
  originalAcceptanceCriteria: story.acceptanceCriteria,
  technicalNotes: story.technicalNotes,
  dependencies: story.dependencies || []
}, null, 2)}

Produce your refined output between <SPEC_AGENT> tags. Include:
- "acceptanceCriteria": The FULL merged list (openspec's criteria + your additions/refinements)
- "notes": What you changed and why (be specific — cite which criteria you added/modified)
- "splitStories": Include if you refined openspec's splits, otherwise omit or pass through
- "acAddedBySpeckit": Array of criteria YOU added that were not in openspec's output
- "acModifiedBySpeckit": Array of {"original":"...","revised":"..."} for criteria you reworded
- "acFlagged": Array of {"criterion":"...","flag":"..."} for criteria that need human attention

<SPEC_AGENT>`;
  try {
    const output = await runClaude(
      claudeCmd, prompt,
      path.join(logDir, `${story.id}-speckit-review.log`)
    );
    const payload = extractTaggedJson(output, 'SPEC_AGENT');
    if (payload) payload.agent = 'speckit';
    return { agent: 'speckit', payload };
  } catch (error) {
    console.warn(`spec-mode: speckit review failed for ${story.id}:`, error.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = regex.exec(text);
  if (!match) return null;
  let jsonText = match[1].trim();
  // Strip markdown code fences that LLMs often wrap around JSON
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
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
    const proc = spawn(cmd, ['-p', '--dangerously-skip-permissions'], { env });
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


run().catch((err) => {
  console.error('spec-mode-runner failed:', err);
  process.exit(1);
});
