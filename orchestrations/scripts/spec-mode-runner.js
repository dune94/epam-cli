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
let _jsonrepair;
try { _jsonrepair = require('jsonrepair').jsonrepair; } catch { _jsonrepair = null; }

// ─── MiniMax tool-use definitions ────────────────────────────────────────────
// Tool-use produces API-enforced valid JSON arguments — eliminates the M3
// unescaped-char / truncation parse failures seen with raw JSON output.

const MINIMAX_BASE_URL = 'https://api.minimaxi.chat/v1';

const TOOL_SPEC_ASSIGNMENTS = {
  name: 'submit_assignments',
  description: 'Submit agent assignment decisions for each story in the phase.',
  parameters: {
    type: 'object',
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['storyId', 'agents'],
          properties: {
            storyId: { type: 'string' },
            agents: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
            priority: { type: 'string' },
          },
        },
      },
    },
  },
};

const TOOL_SPEC_AGENT = {
  name: 'submit_spec_result',
  description: 'Submit the specification analysis result for one story.',
  parameters: {
    type: 'object',
    required: ['storyId', 'agent', 'acceptanceCriteria'],
    properties: {
      storyId: { type: 'string' },
      agent: { type: 'string' },
      notes: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' } },
      description: { type: 'string' },
      title: { type: 'string' },
      acAddedBySpeckit: { type: 'array', items: { type: 'string' } },
      acModifiedBySpeckit: { type: 'array', items: { type: 'object' } },
      acFlagged: { type: 'array', items: { type: 'object' } },
      splitStories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            agentRole: { type: 'string' },
            technicalNotes: { type: 'object' },
          },
        },
      },
    },
  },
};

const TOOL_SPEC_REVIEW = {
  name: 'submit_spec_review',
  description: 'Submit coordinator quality review results for all stories.',
  parameters: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['storyId', 'verdict'],
          properties: {
            storyId: { type: 'string' },
            verdict: { type: 'string' },
            reviewNotes: { type: 'string' },
            qualityScore: { type: 'number' },
            flags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

const TOOL_MODEL_REVIEW = {
  name: 'submit_model_review',
  description: 'Submit final model assignment decisions for all stories.',
  parameters: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['storyId', 'finalModel'],
          properties: {
            storyId: { type: 'string' },
            finalModel: { type: 'string' },
            override: { type: 'boolean' },
            confidence: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

// Call MiniMax API directly with a tool definition — arguments are API-enforced JSON.
// itemsKey: if set, extracts result[itemsKey] (for array-returning tools); otherwise returns full args.
const MINIMAX_TOOL_TIMEOUT_MS = parseInt(process.env.MINIMAX_TOOL_TIMEOUT_MS || '120000', 10);

async function callMiniMaxWithTool(prompt, toolDef, logPath, itemsKey) {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.EPAM_API_KEY_MINIMAX;
  if (!apiKey) throw new Error('callMiniMaxWithTool: no API key (MINIMAX_API_KEY / EPAM_API_KEY_MINIMAX)');
  const model = process.env.AI_MODEL || process.env.ORCH_GATE_MODEL || 'MiniMax-M3';
  const baseURL = process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL;

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.2,
    tools: [{ type: 'function', function: toolDef }],
    tool_choice: { type: 'function', function: { name: toolDef.name } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINIMAX_TOOL_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`MiniMax API error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const rawText = data.choices?.[0]?.message?.content || '';
  const tc = data.choices?.[0]?.message?.tool_calls?.[0];
  const argsRaw = tc?.function?.arguments || '{}';

  if (logPath) {
    fs.writeFileSync(logPath, `# Prompt\n${prompt}\n\n# Tool call args (raw)\n${argsRaw}\n\n# Text output\n${rawText}\n`);
  }

  // Parse args — fall back to jsonrepair on truncated/malformed output from M3
  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch (parseErr) {
    if (_jsonrepair) {
      try {
        args = JSON.parse(_jsonrepair(argsRaw));
        console.warn(`callMiniMaxWithTool: jsonrepair recovered truncated args for tool ${toolDef.name}`);
      } catch {
        console.warn(`callMiniMaxWithTool: failed to parse tool args even with jsonrepair (tool=${toolDef.name}): ${parseErr.message}`);
        return null;
      }
    } else {
      console.warn(`callMiniMaxWithTool: failed to parse tool args (tool=${toolDef.name}): ${parseErr.message}`);
      return null;
    }
  }

  return itemsKey ? (args[itemsKey] ?? null) : args;
}

// Unified agent runner: tool-use for MiniMax, raw JSON for all other providers.
// Ladder: if minimax times out or returns null, escalates to SPEC_PASS_LADDER_PROVIDER
// (default: openai via OpenRouter) using the raw JSON + jsonrepair path.
//
// Fast-path: set SPEC_MODE_PROVIDER=qwen to skip MiniMax entirely.
//   SPEC_MODE_OPENSPEC_MODEL — model for openspec calls (default: moonshotai/kimi-k2)
//   SPEC_MODE_SPECKIT_MODEL  — model for speckit calls  (default: zhipuai/glm-4-plus)
//   SPEC_MODE_MODEL          — fallback for all other spec-mode calls (default: moonshotai/kimi-k2)
async function runAgentForJson(execSpec, prompt, toolDef, tag, logPath, itemsKey) {
  const provider = (process.env.AI_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || '').toLowerCase();
  const ladderProvider = (process.env.SPEC_PASS_LADDER_PROVIDER || 'qwen').toLowerCase();

  // Fast-path: bypass MiniMax entirely when SPEC_MODE_PROVIDER is set.
  // Detects openspec vs speckit from logPath to pick the right model.
  const specModeProvider = (process.env.SPEC_MODE_PROVIDER || '').toLowerCase();
  if (specModeProvider) {
    const logName = (logPath || '').toLowerCase();
    let specModel;
    if (logName.includes('speckit')) {
      specModel = process.env.SPEC_MODE_SPECKIT_MODEL || 'zhipuai/glm-4-plus';
    } else if (logName.includes('openspec') || logName.includes('-openspec-') || logName.includes('-spec.log')) {
      specModel = process.env.SPEC_MODE_OPENSPEC_MODEL || 'moonshotai/kimi-k2';
    } else {
      specModel = process.env.SPEC_MODE_MODEL || process.env.SPEC_MODE_OPENSPEC_MODEL || 'moonshotai/kimi-k2';
    }
    console.log(`spec-mode: fast-path ${specModeProvider}/${specModel} (skipping MiniMax)`);
    const directExec = { cmd: execSpec.cmd, args: ['--provider', specModeProvider, '--model', specModel] };
    const output = await runClaude(directExec, prompt, logPath, {});
    return extractTaggedJson(output, tag);
  }

  if (provider === 'minimax') {
    let result = null;
    try {
      result = await callMiniMaxWithTool(prompt, toolDef, logPath, itemsKey);
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || /aborted/i.test(err.message);
      console.warn(`spec-mode: minimax tool-use failed (${err.message})${isTimeout ? ' — laddering to ' + ladderProvider : ''}`);
      if (!isTimeout) throw err; // hard failure (no API key etc.) — don't ladder, surface the error
    }
    if (result !== null) return result;
    // null = parse failed or aborted — ladder to fallback provider only if fast
    // NOTE: OpenAI ladder via epam CLI spawns detached grandchildren that survive
    // the 120s SIGKILL, causing indefinite hangs. Skip ladder when disabled.
    if (process.env.SPEC_PASS_SKIP_LADDER === '1') {
      console.warn(`spec-mode: minimax returned null — ladder disabled, using fallback spec`);
      return null;
    }
    console.warn(`spec-mode: minimax returned null — laddering to ${ladderProvider}`);
    const ladderTimeout = parseInt(process.env.SPEC_PASS_LADDER_TIMEOUT_MS || String(RUNCLAUDE_TIMEOUT_MS), 10);
    // FIX: build a new execSpec for the ladder. The original execSpec has
    // '--provider minimax' baked into its args. Passing AI_PROVIDER=openai via
    // env overrides is insufficient — ai-run.sh reads the --provider CLI flag,
    // which always wins. Without this fix the ladder calls MiniMax again.
    const ladderExec = { cmd: execSpec.cmd, args: ['--provider', ladderProvider] };
    const output = await Promise.race([
      runClaude(ladderExec, prompt, logPath, {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`ladder hard-timeout after ${ladderTimeout}ms`)), ladderTimeout + 5000))
    ]);
    return extractTaggedJson(output, tag);
  }

  // Non-minimax: existing raw text path with tag extraction + jsonrepair
  const output = await runClaude(execSpec, prompt, logPath);
  return extractTaggedJson(output, tag);
}

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
  const aiRunnerCmd = process.env.AI_RUNNER_CMD || path.join(scriptDir, 'ai-run.sh');
  const monitorScript = path.join(scriptDir, 'update-monitor.sh');
  const promptExec = resolvePromptExec(aiRunnerCmd);
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

Respond with raw JSON only (no XML tags, no markdown fences, no preamble) using this schema:
[
  {"storyId":"EPAM-123","agents":["openspec","speckit"],"notes":"reason","priority":"high"}
]
If a story does not need spec work, provide an empty agents array.

Stories JSON:
${storiesPayload}
`;

  let assignments = null;
  try {
    assignments = await runAgentForJson(
      promptExec,
      coordinatorPrompt,
      TOOL_SPEC_ASSIGNMENTS,
      'SPEC_ASSIGNMENTS',
      path.join(logDir, `spec-coordinator-${opts.phase}.log`),
      'assignments'
    );
  } catch (error) {
    console.warn('spec-mode: coordinator failed, falling back to default agent pair:', error.message);
  }
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
    stats: { acceptanceUpdated: 0, splits: 0, agents: {}, agentFailures: 0, agentAttempts: 0 }
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
    const codeRefs = extractCodeRefs(story);
    const codeHint = codeRefs.length ? ` files=${codeRefs.join(',')}` : '';

    // Run agents SEQUENTIALLY: openspec first, then speckit with openspec's output
    for (const agent of assigned.agents) {
      summary.stats.agentAttempts += 1;
      const beforeSnapshot = captureStorySnapshot(story);
      await emitMonitorEvent({
        monitorScript,
        type: 'spec_update',
        message: `[${opts.phase}] ${agent} started on ${story.id} (${story.title || 'story'})${codeHint}`,
        storyId: story.id,
        role: agent
      });

      let agentResult;
      if (agent === 'speckit' && openspecPayload) {
        // Speckit receives openspec's output for collaborative review
        agentResult = await runSpeckitReview({
          promptExec, story, openspecOutput: openspecPayload,
          phase: opts.phase, runId, logDir
        });
      } else {
        agentResult = await runSpecAgent({
          promptExec, agent, story, phase: opts.phase, runId, logDir
        });
      }

      if (!agentResult || !agentResult.payload) {
        summary.stats.agentFailures += 1;
        await emitMonitorEvent({
          monitorScript,
          type: 'error',
          message: `[${opts.phase}] ${agent} produced no parsable output for ${story.id}${codeHint}`,
          storyId: story.id,
          role: agent
        });
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
      await emitMonitorEvent({
        monitorScript,
        type: 'spec_update',
        message:
          `[${opts.phase}] ${agent} updated ${story.id}` +
          ` acChanged=${changes.acceptanceChanged ? 'yes' : 'no'}` +
          ` splitCount=${changes.splitCount}${codeHint}`,
        storyId: story.id,
        role: agent
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

    let reviews = null;
    try {
      reviews = await runAgentForJson(
        promptExec,
        reviewPrompt,
        TOOL_SPEC_REVIEW,
        'SPEC_REVIEW',
        path.join(logDir, `spec-coordinator-review-${opts.phase}.log`),
        'items'
      );
    } catch (error) {
      console.warn('spec-mode: coordinator review failed:', error.message);
    }
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

  // ── Step 5: Model adequacy re-assessment ──────────────────────────────
  // Pass A (rule-based): score every story against measurable complexity signals.
  // Pass B (LLM review): coordinator reviews all scores — confirms, overrides, or
  //   catches false negatives the rules missed. LLM decision is final.
  // Both passes write to story.specification.modelUpgrade for full auditability.
  const upgradeModel = process.env.ORCH_UPGRADE_MODEL || 'anthropic/claude-sonnet-4-6';
  const miniModel    = process.env.ORCH_MINI_MODEL    || 'MiniMax-M2.5';
  const allPhaseStories = [...stories, ...newStories.map((ns) => ns.story)];

  // Pass A — rule-based signals for every story that has a model assigned
  const ruleAssessments = [];
  for (const story of allPhaseStories) {
    if (!story.model) continue;
    const signals = modelComplexitySignals(story);
    ruleAssessments.push({
      storyId: story.id,
      currentModel: story.model,
      isMini: isMiniTierModel(story.model),
      ruleRecommendation: signals.needsUpgrade ? upgradeModel : story.model,
      ruleUpgrade: signals.needsUpgrade,
      ruleReason: signals.reason || 'no upgrade signal detected',
      signals: {
        acCount: signals.acCount,
        singleFile: signals.isSingleFile,
        htmlOutput: signals.hasHtmlOutput,
        selfContained: signals.hasSelfContainedKeyword
      }
    });
  }

  // Pass B — LLM coordinator reviews all rule assessments
  let finalAssessments = ruleAssessments.map((a) => ({ ...a, finalModel: a.ruleRecommendation, llmOverride: false, llmReason: '' }));
  try {
    const storyContextForReview = allPhaseStories
      .filter((s) => s.model)
      .map((s) => {
        const ra = ruleAssessments.find((a) => a.storyId === s.id);
        return {
          id: s.id,
          title: s.title,
          description: (s.description || '').slice(0, 400),
          acCount: Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.length : 0,
          outputFiles: (s.technicalNotes?.files || []).filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts')),
          currentModel: s.model,
          ruleUpgrade: ra ? ra.ruleUpgrade : false,
          ruleReason: ra ? ra.ruleReason : '',
          signals: ra ? ra.signals : {}
        };
      });

    const modelReviewPrompt = `You are the EPAM CLI model assignment coordinator for phase ${opts.phase}.

A rule-based pass has already assessed every story's model assignment. Your job is to make the FINAL decision on each story's model — confirming rule recommendations, overriding them when wrong, and catching any false negatives the rules missed.

## Available model tiers
- **mini-tier** (fast, lower cost): ${miniModel}
  Best for: simple tasks, small outputs, <8 ACs, modifying existing code, writing single focused functions
  Risk: will timeout or fail on large generation tasks (>1500 output tokens in one turn)

- **standard-tier** (higher capability): ${upgradeModel}
  Best for: large single-file generation, 10+ ACs, HTML/UI files, self-contained complete modules
  Use when: story needs to generate >1000 tokens reliably in one turn

## Your decision criteria
UPGRADE to standard-tier when:
- Story must generate a large, complete artifact (full HTML page, large TypeScript module) in one agent turn
- Story has >12 ACs targeting a single file output — generation load exceeds mini-tier reliability
- Description uses "self-contained", "complete", "no build step" — indicates large monolithic output
- Story involves HTML/CSS/JS UI generation — models smaller than standard-tier produce inconsistent results

KEEP mini-tier when:
- Story modifies existing code or adds small targeted functions
- Output is small (<500 tokens estimated), well-scoped, and narrowly defined
- Story primarily writes tests against already-specified contracts
- AC count is high but spread across multiple small files, not one large generation

IMPORTANT: A false negative (keeping mini when standard is needed) wastes 5+ minutes per attempt and burns 2 retries. A false positive (upgrading when mini would work) costs ~$0.01 extra. Err toward upgrading for borderline cases.

## Stories to assess
${JSON.stringify(storyContextForReview, null, 2)}

Respond with JSON between <MODEL_REVIEW> and </MODEL_REVIEW>:
[
  {
    "storyId": "...",
    "finalModel": "keep-current | <model-string>",
    "override": true/false,
    "confidence": "high|medium|low",
    "reason": "one sentence"
  }
]
Use "keep-current" to accept the current (possibly rule-upgraded) model. Only provide a model string when changing it.

<MODEL_REVIEW>
</MODEL_REVIEW>`;

    const llmDecisions = await runAgentForJson(
      promptExec,
      modelReviewPrompt,
      TOOL_MODEL_REVIEW,
      'MODEL_REVIEW',
      path.join(logDir, `spec-model-review-${opts.phase}.log`),
      'items'
    );
    if (Array.isArray(llmDecisions)) {
      // Tier label → canonical model ID (LLM sometimes echoes the tier label instead of a real model string)
      const TIER_LABEL_MAP = {
        'standard-tier': upgradeModel,
        'mini-tier':     miniModel,
        'nano-tier':     miniModel,
        'premium-tier':  process.env.ORCH_PREMIUM_MODEL || upgradeModel,
      };
      const resolveTierLabel = (m) => (m && TIER_LABEL_MAP[m]) ? TIER_LABEL_MAP[m] : m;

      const decisionMap = new Map();
      llmDecisions.forEach((d) => { if (d && d.storyId) decisionMap.set(d.storyId, d); });
      finalAssessments = finalAssessments.map((fa) => {
        const decision = decisionMap.get(fa.storyId);
        if (!decision) return fa;
        const rawModel = decision.finalModel && decision.finalModel !== 'keep-current'
          ? decision.finalModel
          : fa.ruleRecommendation;
        const llmModel = resolveTierLabel(rawModel);
        return {
          ...fa,
          finalModel: llmModel,
          llmOverride: decision.override === true,
          llmReason: decision.reason || '',
          llmConfidence: decision.confidence || 'medium'
        };
      });
      console.log(`spec-mode: LLM model review completed for ${llmDecisions.length} stories`);
    }
  } catch (err) {
    console.warn('spec-mode: LLM model review failed, using rule-based decisions only:', err.message);
  }

  // Apply final decisions
  const modelChanges = [];
  for (const fa of finalAssessments) {
    const story = allPhaseStories.find((s) => s.id === fa.storyId);
    if (!story) continue;
    if (fa.finalModel !== story.model) {
      const prev = story.model;
      story.model = fa.finalModel;
      if (!story.specification) story.specification = {};
      story.specification.modelUpgrade = {
        from: prev,
        to: fa.finalModel,
        ruleSignals: fa.signals,
        ruleReason: fa.ruleReason,
        llmOverride: fa.llmOverride,
        llmReason: fa.llmReason,
        llmConfidence: fa.llmConfidence || null,
        upgradedAt: new Date().toISOString()
      };
      modelChanges.push({ storyId: story.id, from: prev, to: fa.finalModel, llmOverride: fa.llmOverride });
      console.log(`spec-mode: model set ${story.id}: ${prev} → ${fa.finalModel}${fa.llmOverride ? ' [LLM override]' : ''}`);
    }
  }
  if (modelChanges.length > 0) {
    summary.stats.modelUpgrades = modelChanges;
  }

  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  summary.completedAt = new Date().toISOString();
  summary.storyCount = summary.stories.length;
  fs.writeFileSync(path.join(specRunDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(logDir, 'spec-summary.json'), JSON.stringify(summary, null, 2));
  await emitMonitorEvent({
    monitorScript,
    type: 'spec_update',
    message: `[${opts.phase}] specification completed run=${runId} stories=${summary.storyCount}`,
    role: 'spec-coordinator'
  });
  console.log(`spec-mode: completed for phase ${opts.phase} (run ${runId})`);

  // Abort pipeline if every agent invocation failed — indicates a broken provider/runner
  if (summary.stats.agentAttempts > 0 && summary.stats.agentFailures === summary.stats.agentAttempts) {
    console.error(
      `spec-mode: FATAL — all ${summary.stats.agentAttempts} agent invocations failed for phase ${opts.phase}. ` +
      `Check EPAM_ORCHESTRATION_PROVIDER is set and supported by ai-run.sh.`
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent prompt builders
// ─────────────────────────────────────────────────────────────────────────────

// openspec: first-pass elaboration
async function runSpecAgent({ promptExec, agent, story, phase, runId, logDir }) {
  const acCount = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0;
  const files = story.technicalNotes?.files || [];
  const testFiles = files.filter(f => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
  const implFiles = files.filter(f => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
  const splitDepthVal = story.specification?.splitDepth ?? 0;

  const storyPayload = JSON.stringify({
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    acCount,
    technicalNotes: story.technicalNotes,
    agentRole: story.agentRole,
    agentGroup: story.agentGroup,
    dependencies: story.dependencies || [],
    splitDepth: splitDepthVal
  }, null, 2);

  const splitWarning = acCount > 12
    ? `\nNOTE: This story has ${acCount} acceptance criteria — MANDATORY split required (see SPLIT RULES below).`
    : testFiles.length > 0 && implFiles.length > 0
      ? `\nNOTE: This story contains both implementation (${implFiles.length}) and test (${testFiles.length}) files — MANDATORY split required.`
      : '';

  // Surface any prior coordinator flags so openspec addresses them rather than rubber-stamping
  const priorFlags = story.specification?.coordinatorReview?.flags;
  const priorNotes = story.specification?.coordinatorReview?.reviewNotes;
  const priorGapsBlock = (Array.isArray(priorFlags) && priorFlags.length > 0)
    ? `\n\nPRIOR COORDINATOR FLAGS (you MUST address each one — do NOT declare the spec complete without resolving these):\n${priorFlags.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n${priorNotes ? `\nAdditional context from prior review: ${priorNotes.slice(0, 500)}` : ''}`
    : '';

  const prompt = `You are the ${agent} specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.${splitWarning}${priorGapsBlock}

Generate refined acceptance criteria, optionally updated title/description, and split stories where required. Output raw JSON only (no XML tags, no markdown fences, no preamble) using this schema:
{
  "storyId":"${story.id}",
  "agent":"${agent}",
  "notes":"context",
  "acceptanceCriteria":["..."],
  "description":"...",
  "title":"...",
  "splitStories":[{"id":"optional","title":"...","description":"...","acceptanceCriteria":["..."],"agentRole":"...","technicalNotes":{"files":[]}}]
}
Use existing text when no change is needed.

SPLIT RULES (mandatory, not optional — enforce these before refining AC):
1. AC count > 12 → you MUST propose a split. Target ≤8 ACs per split child. Never leave a story with >12 ACs unsplit.
2. Both implementation files AND test files in technicalNotes.files → split into one impl child (non-test files) and one test child (*.test.ts files). Assign agentRole "typescript-engineer" to impl, "test-engineer" to test.
3. 3+ independent deliverable modules with no shared exports (e.g. client.ts, server.ts, cli.ts all in same story) → split per concern. Each split gets the files it owns.
4. External API discovery + implementation in same story → split: first child discovers/documents the API contract, second child implements against that contract.
These rules apply only when splitDepth === 0. Never split a story that is already a split child.

Story context:
${storyPayload}
`;
  try {
    const payload = await runAgentForJson(
      promptExec, prompt, TOOL_SPEC_AGENT, 'SPEC_AGENT',
      path.join(logDir, `${story.id}-${agent}-spec.log`), null
    );
    return { agent, payload };
  } catch (error) {
    console.warn(`spec-mode: ${agent} run failed for ${story.id}:`, error.message);
    return null;
  }
}

// ─── Speckit AC validator (runtime version mirrors test/unit/orchestration/speckit-validator.test.ts)
const PRESCRIPTIVE_AC_PATTERNS = [
  { pattern: /vi\.mock\s*\(/i,              reason: 'prescribes vi.mock() call' },
  { pattern: /vi\.spyOn\s*\(/i,             reason: 'prescribes vi.spyOn() call' },
  { pattern: /jest\.mock\s*\(/i,            reason: 'prescribes jest.mock() call' },
  { pattern: /jest\.fn\s*\(/i,              reason: 'prescribes jest.fn() call' },
  { pattern: /\.?mockReturnValue[\s(]/i,    reason: 'prescribes mockReturnValue' },
  { pattern: /\.?mockResolvedValue[\s(]/i,  reason: 'prescribes mockResolvedValue' },
  { pattern: /\.?mockImplementation[\s(]/i, reason: 'prescribes mockImplementation' },
  { pattern: /import\s+\{[^}]+\}\s+from/i, reason: 'prescribes exact import statement' },
  { pattern: /require\s*\(\s*['"`]/i,       reason: 'prescribes require() call' },
  { pattern: /^use supertest/i,             reason: 'prescribes supertest usage' },
  { pattern: /^import\s+/i,                reason: 'prescribes import statement' },
];

function stripPrescriptiveACs(acceptanceCriteria, storyId) {
  const clean = [];
  const flagged = [];
  for (const ac of (acceptanceCriteria || [])) {
    const hit = PRESCRIPTIVE_AC_PATTERNS.find(({ pattern }) => pattern.test(ac.trim()));
    if (hit) {
      console.warn(`spec-mode: speckit validator stripped prescriptive AC from ${storyId}: [${hit.reason}] "${ac.slice(0, 80)}"`);
      flagged.push({ criterion: ac, flag: `speckit-validator: ${hit.reason} — describes HOW not WHAT` });
    } else {
      clean.push(ac);
    }
  }
  return { clean, flagged };
}

// speckit: second-pass review of openspec's output — the collaboration point
async function runSpeckitReview({ promptExec, story, openspecOutput, phase, runId, logDir }) {
  const prompt = `You are the speckit specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.

You are reviewing and building on the openspec agent's output for this story.
Your role is COLLABORATIVE — you are NOT starting from scratch. Instead:
1. Review openspec's proposed acceptance criteria for testability and completeness
2. Add missing edge-case, error-handling, security, and accessibility criteria
3. Flag any AC that are vague, untestable, or overlapping
4. If openspec proposed story splits, validate the decomposition and refine AC per split
5. Do NOT remove or duplicate openspec's good work — build on it

━━━ WHAT-NOT-HOW RULE (MANDATORY) ━━━
Every AC must describe an OBSERVABLE OUTCOME (what a test can verify from outside the code),
NOT an implementation instruction. If an AC names vi.mock, jest.fn, mockReturnValue,
mockResolvedValue, import statements, or require() calls, REPLACE it with a
Given/When/Then behaviour statement. Never tell the implementer which library or mock pattern to use.

━━━ SPLIT RULES ━━━
MANDATORY split conditions (your independent obligation — do not defer to openspec):
- Count the acceptanceCriteria in openspec's output. If the parent story still has >12 ACs and openspec did NOT propose splits, you MUST propose them yourself. Target ≤8 ACs per split child.
- If technicalNotes.files contains both *.test.ts and non-test files AND openspec did not split, you MUST split into impl/test children.
- If openspec's splits look correct, pass them through unchanged. If they are unbalanced (one child has >12 ACs), rebalance.
- Set "agentRole" on each split child: "typescript-engineer" for impl, "test-engineer" for test-only children.
- Do NOT split stories that are already split children (splitDepth > 0).
HARD LIMITS enforced in code (not just guidelines — violations are rejected automatically):
- Each split child MUST have ≤24 ACs. Excess ACs are silently truncated at registration.
- Each parent may have at most 4 split children total. A 5th child proposal is rejected.
- Depth ≥2 stories cannot be split further. Proposals for depth-2+ parents are dropped.
- No two split children may declare the same non-test file in technicalNotes.files. If they do,
  the ENTIRE split is rejected and the parent runs as a single story. Each file must have exactly
  one owning child. Test files (*.test.ts, *.spec.ts) are exempt — multiple test children for one
  impl file is valid.

OPENSPEC'S OUTPUT (your input to review — ACs and split proposals only):
${JSON.stringify({
  acceptanceCriteria: openspecOutput?.acceptanceCriteria || [],
  notes: openspecOutput?.notes || '',
  splitStories: openspecOutput?.splitStories || undefined,
}, null, 2)}

ORIGINAL STORY CONTEXT:
${JSON.stringify({
  id: story.id,
  title: story.title,
  description: story.description,
  originalAcceptanceCriteria: story.acceptanceCriteria,
  technicalNotes: story.technicalNotes,
  dependencies: story.dependencies || []
}, null, 2)}

Produce your refined output as raw JSON only (no XML tags, no markdown fences, no preamble). Include:
- "acceptanceCriteria": The FULL merged list (openspec's criteria + your additions/refinements). Every item MUST be an observable outcome, not an implementation instruction.
- "notes": What you changed and why (be specific — cite which criteria you added/modified/replaced)
- "splitStories": Include if you refined openspec's splits, otherwise omit or pass through
- "acAddedBySpeckit": Array of criteria YOU added that were not in openspec's output
- "acModifiedBySpeckit": Array of {"original":"...","revised":"..."} for criteria you reworded
- "acFlagged": Array of {"criterion":"...","flag":"..."} for criteria that need human attention
`;
  try {
    const payload = await runAgentForJson(
      promptExec, prompt, TOOL_SPEC_AGENT, 'SPEC_AGENT',
      path.join(logDir, `${story.id}-speckit-review.log`), null
    );
    if (payload) {
      payload.agent = 'speckit';
      // Post-process: strip any prescriptive HOW-to-implement ACs the model still produced
      const { clean, flagged } = stripPrescriptiveACs(payload.acceptanceCriteria, story.id);
      if (flagged.length > 0) {
        payload.acceptanceCriteria = clean;
        payload.acFlagged = [...(payload.acFlagged || []), ...flagged];
        console.log(`spec-mode: speckit validator stripped ${flagged.length} prescriptive AC(s) from ${story.id}`);
      }
      // Also validate splitStories children
      if (Array.isArray(payload.splitStories)) {
        for (const child of payload.splitStories) {
          if (!child.acceptanceCriteria) continue;
          const { clean: childClean, flagged: childFlagged } = stripPrescriptiveACs(child.acceptanceCriteria, `${story.id}/${child.id}`);
          if (childFlagged.length > 0) {
            child.acceptanceCriteria = childClean;
            child.acFlagged = [...(child.acFlagged || []), ...childFlagged];
          }
        }
      }
    }
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
      // Guard: only accept known agent names — LLM sometimes returns review content as agent name
      const VALID_AGENTS = new Set(['openspec', 'speckit']);
      const rawAgents = Array.isArray(entry.agents) ? entry.agents : [];
      const agents = rawAgents.filter(a => typeof a === 'string' && VALID_AGENTS.has(a));
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

// Count split depth by walking the createdFrom chain back to the root story.
function splitDepth(story, prd) {
  let depth = 0;
  let parentId = story.specification?.createdFrom;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    const parent = prd.stories.find((s) => s.id === parentId);
    parentId = parent?.specification?.createdFrom;
  }
  return depth;
}

// Detect same-file coherence violations: multiple split children claiming to write
// the same non-test file. Each agent rewrites the file from scratch, so the last
// writer wins and all prior agents' work is silently discarded.
// Returns array of {file, childIds} conflicts. Empty array = coherent.
function validateSplitFileCoherence(children) {
  const fileToChildren = new Map();
  for (const child of children) {
    const files = (child.technicalNotes?.files || [])
      .filter(f => typeof f === 'string')
      .filter(f => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
    for (const file of files) {
      if (!fileToChildren.has(file)) fileToChildren.set(file, []);
      fileToChildren.get(file).push(child.id);
    }
  }
  const conflicts = [];
  for (const [file, childIds] of fileToChildren) {
    if (childIds.length > 1) conflicts.push({ file, childIds });
  }
  return conflicts;
}

// Hard code enforcement for split eligibility — not a prompt instruction, a code invariant.
// Called before registering any split child (per-child, so budget check tightens as children accumulate).
const MAX_ACS_PER_STORY = parseInt(process.env.SPEC_MAX_ACS || '24', 10);
const MAX_CHILDREN_PER_SPLIT = parseInt(process.env.SPEC_MAX_CHILDREN || '4', 10);

function canSplitStory(story, prd, newStories) {
  const maxSplitDepth = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
  const currentDepth = splitDepth(story, prd);
  if (currentDepth >= maxSplitDepth) {
    return { ok: false, reason: `depth ${currentDepth} >= max ${maxSplitDepth}` };
  }
  const existingChildren = (prd.stories || []).filter(
    s => s.specification?.createdFrom === story.id
  ).length;
  const pendingChildren = (newStories || []).filter(
    ns => ns.parentId === story.id
  ).length;
  if (existingChildren + pendingChildren >= MAX_CHILDREN_PER_SPLIT) {
    return { ok: false, reason: `split budget exhausted (${existingChildren + pendingChildren} children >= max ${MAX_CHILDREN_PER_SPLIT})` };
  }
  return { ok: true, reason: '' };
}

// AC cap — modifies story in place, logs if truncated
function capSplitACs(story, parentId) {
  const acs = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [];
  if (acs.length > MAX_ACS_PER_STORY) {
    console.warn(`spec-mode: AC cap enforced on ${story.id} (child of ${parentId}): ${acs.length} → ${MAX_ACS_PER_STORY}`);
    story.acceptanceCriteria = acs.slice(0, MAX_ACS_PER_STORY);
  }
}

function applySpecChanges(story, payload, newStories, prd, phaseId, runId) {
  const result = { acceptanceChanged: false, splitCount: 0 };
  if (Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length) {
    const capped = payload.acceptanceCriteria.slice(0, MAX_ACS_PER_STORY);
    if (capped.length < payload.acceptanceCriteria.length) {
      console.warn(`spec-mode: AC cap enforced on ${story.id}: ${payload.acceptanceCriteria.length} → ${capped.length}`);
    }
    const before = JSON.stringify(story.acceptanceCriteria || []);
    const after = JSON.stringify(capped);
    if (before !== after) {
      story.acceptanceCriteria = capped;
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
    const currentDepth = splitDepth(story, prd);
    const maxSplitDepth = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
    if (currentDepth >= maxSplitDepth) {
      console.warn(
        `spec-mode: skipping splits for ${story.id} — depth ${currentDepth} >= max ${maxSplitDepth}`
      );
    } else {
      const childrenBefore = newStories.filter(ns => ns.parentId === story.id).length;

      payload.splitStories.forEach((split, idx) => {
        if (!split || typeof split !== 'object') return;
        // Per-child budget check — canSplitStory sees pendingChildren accumulate each iteration
        const { ok, reason } = canSplitStory(story, prd, newStories);
        if (!ok) {
          console.warn(`spec-mode: split budget for ${story.id} child ${idx + 1} rejected — ${reason}`);
          return;
        }
        const baseId = split.id && typeof split.id === 'string' ? split.id : `${story.id}-SPEC-${idx + 1}`;
        let newId = baseId;
        let suffix = 1;
        // Check both prd.stories AND the pending newStories accumulator for collisions
        while (
          prd.stories.some((s) => s.id === newId) ||
          newStories.some((ns) => ns.story.id === newId)
        ) {
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
          runId,
          splitDepth: currentDepth + 1
        };
        capSplitACs(newStory, story.id);
        newStories.push({ parentId: story.id, story: newStory, phase: phaseId });
        result.splitCount += 1;
      });

      // Same-file coherence check: if >1 child writes the same non-test file, each agent
      // overwrites the file from scratch and only the last writer's output survives.
      // Reject the entire split — parent runs as a single story (with capped ACs).
      const addedChildren = newStories.filter(ns => ns.parentId === story.id).slice(childrenBefore);
      const fileConflicts = validateSplitFileCoherence(addedChildren.map(ns => ns.story));
      if (fileConflicts.length > 0) {
        for (const { file, childIds } of fileConflicts) {
          console.warn(
            `spec-mode: split coherence violation for ${story.id}: ` +
            `children [${childIds.join(', ')}] all write to ${path.basename(file)} — ` +
            `rejecting split (last writer wins = silent data loss)`
          );
        }
        // Roll back all children added during this forEach
        newStories.splice(newStories.length - addedChildren.length, addedChildren.length);
        result.splitCount = 0;
      } else if (addedChildren.length > 0) {
        // Parent AC redistribution — clear parent ACs after split to prevent 93-AC parent stories.
        const childIds = addedChildren.map(ns => ns.story.id).join(', ');
        story.acceptanceCriteria = [`Delegated to split children: ${childIds}`];
        console.log(`spec-mode: parent ${story.id} ACs redistributed → delegated to ${childIds}`);
      }
    }
  }
  return result;
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function extractCodeRefs(story) {
  const files = story?.technicalNotes?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (typeof f === 'string' ? f.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
}

function emitMonitorEvent({ monitorScript, type, message, storyId = '', lane = 'main', role = '' }) {
  return new Promise((resolve) => {
    const proc = spawn(
      monitorScript,
      ['event', type, message, storyId, lane, role],
      { env: process.env }
    );
    proc.on('error', () => resolve());
    proc.on('close', () => resolve());
  });
}

function extractTaggedJson(text, tag) {
  if (!text) return null;

  // Normalize variant opening tags that models sometimes emit:
  //   <_TAG>  →  <TAG>   (Qwen adds leading underscore to distinguish from template echo)
  //   <-TAG>  →  <TAG>   (similar dash-prefix variant)
  text = text.replace(new RegExp(`<[_\\-]${tag}>`, 'g'), `<${tag}>`);

  function stripAndParse(jsonText) {
    jsonText = jsonText.trim();
    // Strip markdown code fences that LLMs often wrap around JSON
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try {
      return JSON.parse(jsonText);
    } catch (err) {
      // Try jsonrepair for M3-style malformed JSON (truncated strings, unescaped chars, double braces).
      // Only attempt repair when text looks like JSON (starts with { or [) to avoid
      // jsonrepair turning arbitrary plain text into a JSON string.
      if (_jsonrepair && /^\s*[{[]/.test(jsonText)) {
        try {
          return JSON.parse(_jsonrepair(jsonText));
        } catch (repairErr) {
          console.warn(`Failed to parse JSON for tag ${tag}:`, err.message);
        }
      } else {
        console.warn(`Failed to parse JSON for tag ${tag}:`, err.message);
      }
      return null;
    }
  }

  // Full pair: <TAG>content</TAG> — find ALL matches, return the last parseable one.
  // Models sometimes echo an empty template block from the prompt before outputting
  // their real content (e.g. coordinator prompt contains empty <SPEC_ASSIGNMENTS></SPEC_ASSIGNMENTS>
  // which the model echoes, then outputs the real block after "# Output").
  const fullRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const fullMatches = [...text.matchAll(fullRegex)];
  if (fullMatches.length > 0) {
    // Try matches in reverse — prefer the last well-formed JSON block
    for (let i = fullMatches.length - 1; i >= 0; i--) {
      const parsed = stripAndParse(fullMatches[i][1]);
      if (parsed !== null) return parsed;
    }
    // All full-pair matches failed to parse; fall through to partial-match fallback
  }

  // Partial (SDK single-turn): prompt injected the opening tag, model response
  // contains only content followed by </TAG>. Match everything up to the close tag.
  const closeRegex = new RegExp(`^([\\s\\S]*?)<\\/${tag}>`, 'm');
  const closeMatch = closeRegex.exec(text.trim());
  if (closeMatch) return stripAndParse(closeMatch[1]);

  // Raw JSON fallback: model ignored tag instructions and returned bare JSON.
  // Strip markdown fences then try parsing the entire response directly.
  const rawAttempt = stripAndParse(text);
  if (rawAttempt !== null) return rawAttempt;

  return null;
}

const RUNCLAUDE_TIMEOUT_MS = parseInt(process.env.RUNCLAUDE_TIMEOUT_MS || '120000', 10);

function runClaude(execSpec, prompt, logPath, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    delete env.CLAUDECODE;
    const cmd = execSpec?.cmd;
    if (!cmd) {
      return reject(new Error('prompt runner exited with code 1: no execSpec.cmd — set EPAM_ORCHESTRATION_PROVIDER'));
    }
    const args = Array.isArray(execSpec?.args) ? execSpec.args : [];
    // detached:true puts the child in its own process group so we can kill the
    // entire group (child + grandchildren like epam CLI) on timeout.
    const proc = spawn(cmd, args, { env, detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    };

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      // FIX: destroy stdio streams so grandchildren that inherited these pipe fds
      // (e.g. epam CLI spawning detached node subprocesses) don't keep the Node.js
      // event loop alive after the process group is killed.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      reject(new Error(`prompt runner timed out after ${RUNCLAUDE_TIMEOUT_MS}ms`));
    }, RUNCLAUDE_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => { if (!settled) { settled = true; clearTimeout(killTimer); reject(error); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const output = `${stdout}\n${stderr}`.trim();
      if (logPath) fs.writeFileSync(logPath, `# Prompt\n${prompt}\n\n# Output\n${output}\n`);
      if (code !== 0) {
        return reject(new Error(`prompt runner exited with code ${code}`));
      }
      resolve(output);
    });
    proc.unref(); // don't keep Node alive waiting for the child
    proc.stdin?.on('error', () => { /* suppress EPIPE when process is killed before stdin flush */ });
    proc.stdin?.end(prompt);
  });
}

function resolvePromptProvider(env = process.env) {
  const provider = env.AI_PROVIDER
    || env.EPAM_ORCHESTRATION_PROVIDER
    || (/codex$/.test(env.CLAUDE_CMD || '') ? 'codex' : null);
  if (!provider) {
    throw new Error(
      'No AI provider configured. Set AI_PROVIDER or EPAM_ORCHESTRATION_PROVIDER (e.g. EPAM_ORCHESTRATION_PROVIDER=qwen).'
    );
  }
  return provider;
}

function resolvePromptExec(aiRunnerCmd, env = process.env) {
  const provider = resolvePromptProvider(env);
  const gateModel = env.AI_MODEL || env.ORCH_GATE_MODEL || '';
  const modelArgs = gateModel ? ['--model', gateModel] : [];
  return { cmd: aiRunnerCmd, args: ['--provider', provider, ...modelArgs] };
}

// Returns true when a model string is mini/nano/flash/haiku tier — fast but limited generation capacity.
function isMiniTierModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();
  // Named mini model from env var always qualifies
  const miniModelEnv = (process.env.ORCH_MINI_MODEL || '').toLowerCase();
  if (miniModelEnv && m === miniModelEnv) return true;
  return m.includes('-mini') || m.includes('-nano') || m.includes('-flash') || m.includes('-haiku')
      || m.startsWith('minimax-m2') || m.startsWith('minimax/minimax-m2');
}

// Compute story complexity signals and decide whether the assigned model needs upgrading.
function modelComplexitySignals(story) {
  const acCount = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0;
  const files = story.technicalNotes?.files || [];
  const outputFiles = files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
  const isSingleFile = outputFiles.length === 1;
  const hasHtmlOutput = outputFiles.some((f) => f.endsWith('.html'));
  const desc = (story.description || '').toLowerCase();
  const hasSelfContainedKeyword =
    desc.includes('self-contained') || desc.includes('no build') ||
    desc.includes('complete') || desc.includes('single-file');

  let needsUpgrade = false;
  let reason = '';

  if (acCount > 15 && isSingleFile) {
    needsUpgrade = true;
    reason = `${acCount} ACs on a single output file exceeds mini-tier generation capacity`;
  } else if (acCount > 10 && hasHtmlOutput) {
    needsUpgrade = true;
    reason = `HTML output file with ${acCount} ACs requires strong generation capability`;
  } else if (isSingleFile && hasSelfContainedKeyword && acCount > 8) {
    needsUpgrade = true;
    reason = `self-contained single-file story with ${acCount} ACs needs reliable large output`;
  }

  return { acCount, isSingleFile, hasHtmlOutput, hasSelfContainedKeyword, needsUpgrade, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mid-execution split validation — called from run-agent-orchestration.sh
// after any step that may write new stories to the PRD (Step 0.5, post-story).
//
// Flow: find unvalidated split children → run speckit in parent context →
//       apply AC cap → redistribute parent ACs → mark speckitValidated → write PRD.
// ─────────────────────────────────────────────────────────────────────────────
async function validateMidExecutionSplits(prdFile, storyIdsCsv) {
  const storyIds = (storyIdsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!prdFile || !storyIds.length) {
    console.log('spec-mode: --validate-splits: nothing to validate');
    return;
  }

  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  const scriptDir = path.dirname(fs.realpathSync(process.argv[1]));
  const aiRunnerCmd = process.env.AI_RUNNER_CMD || path.join(scriptDir, 'ai-run.sh');
  const promptExec = resolvePromptExec(aiRunnerCmd);
  const phase = process.env.PHASE || 'unknown';
  const runId = process.env.ORCH_RUN_ID || new Date().toISOString().replace(/[:-]/g, '');
  const logDir = process.env.OUTPUT_DIR || path.join(path.dirname(prdFile), 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const storiesToValidate = storyIds
    .map(id => prd.stories.find(s => s.id === id))
    .filter(s => s && s.specification?.createdFrom && !s.specification?.speckitValidated);

  if (!storiesToValidate.length) {
    console.log('spec-mode: --validate-splits: all target stories already validated or not found');
    return;
  }

  // Group by parent
  const byParent = new Map();
  for (const child of storiesToValidate) {
    const parentId = child.specification.createdFrom;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(child);
  }

  let hardViolations = 0;

  for (const [parentId, children] of byParent) {
    const parentStory = prd.stories.find(s => s.id === parentId);
    if (!parentStory) {
      console.warn(`spec-mode: --validate-splits: parent ${parentId} not in PRD — skipping`);
      continue;
    }

    // Depth guard (code, not prompt)
    const currentDepth = splitDepth(parentStory, prd);
    const maxSplitDepth = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
    if (currentDepth >= maxSplitDepth) {
      console.warn(`spec-mode: --validate-splits: ${parentId} depth ${currentDepth} >= max ${maxSplitDepth} — rejecting ${children.length} children`);
      for (const child of children) {
        child.specification.splitRejected = true;
        child.specification.splitRejectionReason = `depth ${currentDepth} >= max ${maxSplitDepth}`;
        child.status = 'deprecated';
      }
      hardViolations++;
      continue;
    }

    // Split budget guard — count against already-registered children from prior runs
    const existingValidatedChildren = prd.stories.filter(
      s => s.specification?.createdFrom === parentId && s.specification?.speckitValidated
    ).length;
    if (existingValidatedChildren + children.length > MAX_CHILDREN_PER_SPLIT) {
      const allowed = Math.max(0, MAX_CHILDREN_PER_SPLIT - existingValidatedChildren);
      console.warn(`spec-mode: --validate-splits: ${parentId} budget allows ${allowed} more children, got ${children.length} — capping`);
      const rejected = children.splice(allowed);
      for (const r of rejected) {
        r.specification.splitRejected = true;
        r.specification.splitRejectionReason = `split budget exhausted (max ${MAX_CHILDREN_PER_SPLIT})`;
        r.status = 'deprecated';
      }
      if (!children.length) { hardViolations++; continue; }
    }

    // Same-file coherence check — reject entire split if children share a non-test file
    const fileConflicts = validateSplitFileCoherence(children);
    if (fileConflicts.length > 0) {
      for (const { file, childIds } of fileConflicts) {
        console.warn(
          `spec-mode: --validate-splits: coherence violation for ${parentId}: ` +
          `children [${childIds.join(', ')}] all write to ${path.basename(file)} — rejecting split`
        );
      }
      for (const child of children) {
        child.specification.splitRejected = true;
        child.specification.splitRejectionReason = `same-file coherence violation: multiple children write to the same file`;
        child.status = 'deprecated';
      }
      hardViolations++;
      continue;
    }

    // AC cap on each child
    for (const child of children) capSplitACs(child, parentId);

    // Run speckit — treat children as openspec's split proposals
    const openspecOutput = {
      acceptanceCriteria: parentStory.acceptanceCriteria || [],
      notes: 'Mid-execution split registered by agent during story execution',
      splitStories: children.map(c => ({
        id: c.id,
        title: c.title,
        description: c.description,
        acceptanceCriteria: c.acceptanceCriteria || [],
        dependencies: c.dependencies || [],
        agentRole: c.agentRole
      }))
    };

    const speckitResult = await runSpeckitReview({
      promptExec,
      story: parentStory,
      openspecOutput,
      phase,
      runId,
      logDir
    });

    // Apply speckit refinements if returned
    if (speckitResult?.payload?.splitStories) {
      for (const sc of speckitResult.payload.splitStories) {
        const child = children.find(c => c.id === sc.id);
        if (child && Array.isArray(sc.acceptanceCriteria) && sc.acceptanceCriteria.length) {
          const { clean } = stripPrescriptiveACs(sc.acceptanceCriteria, child.id);
          child.acceptanceCriteria = clean.slice(0, MAX_ACS_PER_STORY);
        }
        if (child && sc.notes) {
          child.specification.speckitNotes = sc.notes;
        }
      }
    }

    // Mark children validated
    for (const child of children) {
      child.specification.speckitValidated = true;
      child.specification.speckitValidatedAt = new Date().toISOString();
    }

    // Parent AC redistribution
    const childIds = children.map(c => c.id).join(', ');
    parentStory.acceptanceCriteria = [`Delegated to split children: ${childIds}`];
    console.log(`spec-mode: --validate-splits: ${parentId} → validated ${children.length} children (${childIds})`);
  }

  fs.writeFileSync(prdFile, JSON.stringify(prd, null, 2) + '\n');

  if (hardViolations > 0) {
    console.error(`spec-mode: --validate-splits: ${hardViolations} hard violation(s) — check PRD for deprecated splits`);
    process.exit(1);
  }

  console.log('spec-mode: --validate-splits: complete');
}

if (require.main === module) {
  if (process.argv[2] === '--validate-splits') {
    validateMidExecutionSplits(process.argv[3], process.argv[4]).catch((err) => {
      console.error('spec-mode-runner --validate-splits failed:', err);
      process.exit(1);
    });
  } else {
    run().catch((err) => {
      console.error('spec-mode-runner failed:', err);
      process.exit(1);
    });
  }
}

module.exports = {
  extractTaggedJson,
  buildAssignments,
  captureStorySnapshot,
  splitDepth,
  canSplitStory,
  capSplitACs,
  validateSplitFileCoherence,
  applySpecChanges,
  validateMidExecutionSplits,
  extractCodeRefs,
  resolvePromptProvider,
  resolvePromptExec,
  isMiniTierModel,
  modelComplexitySignals,
  MAX_ACS_PER_STORY,
  MAX_CHILDREN_PER_SPLIT,
};
