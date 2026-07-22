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
const { spawn, execSync } = require('node:child_process');

// Semble code-context retrieval — loaded lazily so the module is optional.
// When SEMBLE_ENABLED=1 and the binary is present, fetchSembleContext() returns
// a formatted block of existing-code snippets to inject into the spec prompt.
let _semble;
function fetchSembleContext(story) {
  if (process.env.SEMBLE_ENABLED !== '1') return '';
  try {
    if (!_semble) _semble = require('./lib/semble-context');
    const repoPath = resolveCodelinePath(story);
    if (!repoPath || !fs.existsSync(repoPath)) return '';

    const isBrownfield = process.env.EPAM_BROWNFIELD === '1';

    // Symptom query — same in both modes; finds code near the described behavior
    const symptomQuery = [story.title, ...(story.acceptanceCriteria || []).slice(0, 3)].join(' ').slice(0, 400);
    const symptomResult = _semble.sembleSearch(symptomQuery, repoPath, 8, 20);

    if (!isBrownfield) {
      if (!symptomResult.results || symptomResult.results.length === 0) return '';
      const block = _semble.formatAsText(symptomResult);
      return `\nEXISTING CODE CONTEXT (from semble semantic search — use this to write precise, grounded ACs):\n${block}\n`;
    }

    // Brownfield: second query targets the service/handler boundary rather than the symptom.
    // Strips stop-words and prefixes with action verbs to find the code path that *implements*
    // the domain behavior, not just code that mentions the same keywords.
    const domainTerms = story.title
      .replace(/\b(the|a|an|is|not|for|in|of|and|or|to|as|at|by|be|was|are|it|its|that|this|with)\b/gi, '')
      .trim()
      .slice(0, 200);
    const pathQuery = `applies handles processes calculates resolves ${domainTerms}`.slice(0, 400);
    const pathResult = _semble.sembleSearch(pathQuery, repoPath, 5, 30);

    // Combine and deduplicate by file+line
    const seen = new Set();
    const combined = [];
    for (const r of [...(symptomResult.results || []), ...(pathResult.results || [])]) {
      const key = `${r.file_path}:${r.start_line}`;
      if (!seen.has(key)) { seen.add(key); combined.push(r); }
    }
    if (combined.length === 0) return '';
    const block = _semble.formatAsText({ results: combined });
    return `\nEXISTING CODE (brownfield — identify the code path that handles this behavior, then specify how to fix it; do not propose new abstractions):\n${block}\n`;
  } catch (e) {
    return '';
  }
}

function resolveCodelinePath(story) {
  // Prefer story-level codeline → JIRA_WORKTREE_<UPPER> → JIRA_WORKTREE_<DEFAULT>
  const cl = story.codeline || process.env.JIRA_DEFAULT_CODELINE || '';
  if (cl) {
    const key = `JIRA_WORKTREE_${cl.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    if (process.env[key]) return process.env[key];
  }
  // Last resort: find any JIRA_WORKTREE_* that is set
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('JIRA_WORKTREE_') && v) return v;
  }
  return '';
}
let _jsonrepair;
try { _jsonrepair = require('jsonrepair').jsonrepair; } catch { _jsonrepair = null; }

// acquireFileLock/releaseFileLock — a bash-`flock`-equivalent for this file's
// two PRD write sites (run() and validateMidExecutionSplits()). Node has no
// built-in flock; this uses exclusive file creation (O_EXCL via the 'wx'
// flag) as the mutual-exclusion primitive, with a stale-lock timeout so a
// killed process's abandoned lock file doesn't block every future run
// forever. Added 2026-07-11 alongside the equivalent bash-side flock wraps in
// claude.sh/run-agent-orchestration.sh -- the atomic write-then-rename fix
// from earlier the same day prevents CORRUPTION from a killed process, but
// does not prevent a LOST UPDATE when two processes (e.g. parallel worktree
// stories) both read-modify-write the same PRD file around the same time.
// staleMs is intentionally a SEPARATE threshold from timeoutMs: timeoutMs is
// how long THIS caller is willing to wait before giving up; staleMs is how
// old an abandoned lock file must be before we assume its owner is dead and
// steal it. Reusing one value for both would mean a caller that waits past
// its own timeout would end up STEALING the lock from a still-live holder
// instead of throwing -- defeating the mutual exclusion the lock exists for.
function acquireFileLock(lockPath, timeoutMs = 30000, staleMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath); // stale lock from a killed process -- steal it
          continue;
        }
      } catch {
        continue; // lock file vanished between EEXIST and stat -- retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      try { execSync('sleep 0.05'); } catch { /* ignore */ }
    }
  }
}

function releaseFileLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

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
const MINIMAX_TOOL_TIMEOUT_MS = parseInt(process.env.MINIMAX_TOOL_TIMEOUT_MS || '180000', 10);

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
//   SPEC_MODE_SPECKIT_MODEL  — model for speckit calls  (default: moonshotai/kimi-k2)
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
      specModel = process.env.SPEC_MODE_SPECKIT_MODEL || 'moonshotai/kimi-k2';
    } else if (logName.includes('openspec') || logName.includes('-openspec-') || logName.includes('-spec.log')) {
      // Brownfield investigation requires tracing call chains through unfamiliar code —
      // use the HIGH model as the base so archaeology doesn't fall back to generation.
      specModel = (process.env.EPAM_BROWNFIELD === '1' && process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH)
        ? process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH
        : process.env.SPEC_MODE_OPENSPEC_MODEL || 'moonshotai/kimi-k2';
    } else {
      specModel = process.env.SPEC_MODE_MODEL || process.env.SPEC_MODE_OPENSPEC_MODEL || 'moonshotai/kimi-k2';
    }
    console.log(`spec-mode: fast-path ${specModeProvider}/${specModel} (skipping MiniMax)`);
    const directExec = { cmd: execSpec.cmd, args: ['--provider', specModeProvider, '--model', specModel] };
    // Spec-mode responses are large JSON blobs — use a higher output-token budget
    // than the implementation default (4096) so speckit never truncates mid-JSON.
    // SPEC_MODE_MAX_OUTPUT_TOKENS is spec-only; it doesn't affect implementation runs.
    const specEnv = process.env.SPEC_MODE_MAX_OUTPUT_TOKENS
      ? { EPAM_MAX_OUTPUT_TOKENS: process.env.SPEC_MODE_MAX_OUTPUT_TOKENS }
      : {};
    const output = await runClaude(directExec, prompt, logPath, specEnv);
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
  const _initialStoryIds = new Set((prd.stories || []).map((s) => s.id));

  // Load agent profiles — spec-coordinator-agent provides the system-level role instruction
  const profilesPath = path.join(automationDir, 'agents', 'profiles.json');
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch { /* no profiles */ }
  const specCoordinatorProfile = profiles['spec-coordinator-agent'] || '';

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

  const coordinatorPrompt = `${specCoordinatorProfile ? specCoordinatorProfile + '\n\n' : ''}You are the EPAM CLI specification coordinator agent for phase ${opts.phase}.

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
    // Captured BEFORE either agent runs — the split-mandate check (after the
    // agent loop below) needs the story's ORIGINAL shape, not an intermediate
    // one, since openspec+speckit can both mutate it across two iterations.
    const originalStorySnapshot = captureStorySnapshot(story);
    let totalSplitCountForStory = 0;

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
      try {
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
      } catch (err) { agentResult = null; }

      // Retry on transient failure (timeout, provider outage).
      // For openspec (the sole split authority), use a HIGH ladder:
      //   retry 1  — same model (transient-timeout recovery)
      //   retry 2+ — escalate to SPEC_MODE_OPENSPEC_MODEL_HIGH if configured
      // SPEC_AGENT_MAX_RETRIES defaults to 3 for openspec, 1 for other agents.
      const _isOpenspec = agent === 'openspec';
      // openspec and speckit are both critical — neither may fail. Both agents get the
      // same 3-retry budget (+ model escalation on attempt 2+). "Failures are not permitted"
      // means: retry to success, or abort the pipeline with exit(1). Never continue silently.
      const _specMaxRetries = parseInt(process.env.SPEC_AGENT_MAX_RETRIES || '3', 10);
      const _openspecHighModel = process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH || process.env.SPEC_MODE_OPENSPEC_MODEL || '';
      const _openspecBaseModel = process.env.SPEC_MODE_OPENSPEC_MODEL || '';
      const _speckitHighModel = process.env.SPEC_MODE_SPECKIT_MODEL_HIGH || process.env.SPEC_MODE_SPECKIT_MODEL || '';
      const _speckitBaseModel = process.env.SPEC_MODE_SPECKIT_MODEL || '';
      let _specRetry = 0;
      while (!agentResult && _specRetry < _specMaxRetries) {
        _specRetry++;
        // For retry 2+, escalate to the HIGH model if it differs from base — both agents.
        const _escalateOpenspec = _isOpenspec && _specRetry >= 2 && _openspecHighModel && _openspecHighModel !== _openspecBaseModel;
        const _escalateSpeckit = !_isOpenspec && agent === 'speckit' && _specRetry >= 2 && _speckitHighModel && _speckitHighModel !== _speckitBaseModel;
        const _escalate = _escalateOpenspec || _escalateSpeckit;
        const _prevModel = _isOpenspec ? _openspecBaseModel : _speckitBaseModel;
        const _nextModel = _isOpenspec ? _openspecHighModel : _speckitHighModel;
        if (_escalate) {
          console.warn(
            `spec-mode: ${agent} ladder escalation for ${story.id} (attempt ${_specRetry + 1}/${_specMaxRetries + 1}) — model ${_prevModel} → ${_nextModel}`
          );
          appendSpecPassEvent(logDir, {
            storyId: story.id,
            phase: opts.phase,
            event: 'spec_timeout_escalation',
            decision: 'escalating',
            details: { agent, prevModel: _prevModel, newModel: _nextModel, retry: _specRetry }
          });
        } else {
          console.warn(
            `spec-mode: ${agent} returned null for ${story.id} (attempt ${_specRetry + 1}/${_specMaxRetries + 1}) — retrying transient failure`
          );
        }
        summary.stats.agentAttempts += 1;
        try {
          if (_escalateOpenspec) {
            const _savedModel = process.env.SPEC_MODE_OPENSPEC_MODEL;
            process.env.SPEC_MODE_OPENSPEC_MODEL = _openspecHighModel;
            try {
              agentResult = await runSpecAgent({ promptExec, agent, story, phase: opts.phase, runId, logDir });
            } finally {
              if (_savedModel !== undefined) process.env.SPEC_MODE_OPENSPEC_MODEL = _savedModel;
              else delete process.env.SPEC_MODE_OPENSPEC_MODEL;
            }
          } else if (_escalateSpeckit) {
            const _savedModel = process.env.SPEC_MODE_SPECKIT_MODEL;
            process.env.SPEC_MODE_SPECKIT_MODEL = _speckitHighModel;
            try {
              agentResult = await runSpeckitReview({ promptExec, story, openspecOutput: openspecPayload, phase: opts.phase, runId, logDir });
            } finally {
              if (_savedModel !== undefined) process.env.SPEC_MODE_SPECKIT_MODEL = _savedModel;
              else delete process.env.SPEC_MODE_SPECKIT_MODEL;
            }
          } else {
            agentResult = agent === 'speckit' && openspecPayload
              ? await runSpeckitReview({ promptExec, story, openspecOutput: openspecPayload, phase: opts.phase, runId, logDir })
              : await runSpecAgent({ promptExec, agent, story, phase: opts.phase, runId, logDir });
          }
        } catch (err) { agentResult = null; }
      }

      if (!agentResult || !agentResult.payload) {
        // openspec/speckit failures are not permitted — hard abort so the run is clearly
        // contaminated and must be relaunched rather than proceeding with an unreviewed PRD.
        await emitMonitorEvent({
          monitorScript,
          type: 'error',
          message: `[${opts.phase}] FATAL — ${agent} produced no parsable output for ${story.id} after ${_specRetry + 1} attempt(s)`,
          storyId: story.id,
          role: agent
        });
        console.error(
          `spec-mode: FATAL — ${agent} returned null for ${story.id} after ${_specRetry + 1} attempt(s). ` +
          `openspec/speckit failures are not permitted. Aborting pipeline. ` +
          `Check SPEC_MODE_SPECKIT_MODEL/SPEC_MODE_OPENSPEC_MODEL and RUNCLAUDE_TIMEOUT_MS.`
        );
        process.exit(1);
      }

      let { payload } = agentResult;

      // Track openspec output so speckit can use it
      if (agent === 'openspec') {
        openspecPayload = payload;
      }

      payload.runId = runId;

      // Deterministic split-authority check (2026-07-13, user request):
      // speckit no longer owns splitting — openspec is the sole authority,
      // and checkSplitMandateViolation's forced-retry on openspec is the
      // real backstop if it misses a mandatory split (a code-level count,
      // not an LLM's "independent obligation" prose instruction, which is
      // what used to grant speckit this power and is exactly the kind of
      // unenforced instruction this pipeline replaces with deterministic
      // checks everywhere else). This is not just a prompt update — the
      // prompt can be ignored, so it's enforced here in code: ANY
      // splitStories speckit emits is unconditionally dropped, regardless of
      // whether openspec already split this story or not. This is the exact
      // collision class (two independently-split, competing child sets for
      // the same parent, rejected by the same-file coherence check, forcing
      // the parent to fall back to an oversized unsplit story) that hit
      // SKY-002 (2026-07-10) and SKY-003 (2026-07-13) live.
      if (agent === 'speckit' && Array.isArray(payload.splitStories) && payload.splitStories.length) {
        console.warn(`spec-mode: speckit proposed splitStories for ${story.id} — dropping (splitting is openspec's decision alone, enforced deterministically, not just by prompt instruction)`);
        delete payload.splitStories;
      }

      const newStoriesCountBefore = newStories.length;
      let changes = applySpecChanges(story, payload, newStories, prd, opts.phase, runId, logDir);

      let afterSnapshot = captureStorySnapshot(story);

      // Reviewer gate — validates the AC/description/title rewrite (and any
      // split children just created) before it's accepted. Runs every phase,
      // every story: this is the spec pass's only content-quality check, since
      // applySpecChanges itself only enforces structural caps (AC count, split
      // depth), not whether the rewritten content is actually good.
      // NOTE: applySpecChanges can rewrite description/title/technicalNotes
      // independently of acceptanceChanged (that flag only tracks the AC
      // array). Check the full snapshot, not just changes.acceptanceChanged,
      // so a description/title-only rewrite doesn't slip through unreviewed.
      const anyFieldChanged =
        changes.acceptanceChanged ||
        changes.splitCount > 0 ||
        afterSnapshot.description !== beforeSnapshot.description ||
        afterSnapshot.title !== beforeSnapshot.title ||
        JSON.stringify(afterSnapshot.technicalNotes) !== JSON.stringify(beforeSnapshot.technicalNotes);
      // A split whose ONLY substantive effect is the deterministic "Delegated
      // to split children" placeholder has nothing left for a content
      // reviewer to assess — applySpecChanges already verified the split's
      // structural correctness (file coherence, depth, budget). Skip the
      // review call entirely rather than asking an LLM to judge a
      // machine-generated marker it has no way to recognize as one.
      if (anyFieldChanged && isSplitDelegationOnlyChange(beforeSnapshot, afterSnapshot, changes.splitCount)) {
        console.log(`spec-mode: skipping prd-change-reviewer for ${story.id} — split-only change (delegation marker is deterministic, already structurally verified)`);
      } else if (anyFieldChanged) {
        let reviewResult = await reviewPrdChange({
          aiRunnerCmd, profiles, storyId: story.id, changeType: 'spec_pass',
          before: beforeSnapshot, after: afterSnapshot, logDir,
          splitOccurred: changes.splitCount > 0
        });

        // Retry-on-violation (2026-07-13): a content-quality rejection here
        // used to just revert and move on — never tell the SAME agent what
        // was actually wrong and let it try again. Same "detect, explain,
        // retry" shape as checkSplitMandateViolation's existing precedent
        // below, but an INDEPENDENT 2-attempt budget: that check catches a
        // different violation class (a mandatory split that was skipped
        // entirely), while this one catches rejected AC/description/title
        // content — seeding both in the same test must show 2+1 attempts
        // total, not one shared counter.
        let acReviewAttempts = 1;
        while (reviewResult.verdict === 'fail' && acReviewAttempts < 3) {
          acReviewAttempts += 1;
          const correctiveNote =
            `CRITICAL — YOUR PREVIOUS OUTPUT WAS REJECTED BY REVIEW: ${reviewResult.issues.join('; ') || 'quality issues found'}. ` +
            `Fix this and try again. Do not repeat the same mistake.`;
          let retryResult;
          try {
            retryResult = agent === 'speckit'
              ? await runSpeckitReview({ promptExec, story, openspecOutput: openspecPayload, phase: opts.phase, runId, logDir, forcedRetryNote: correctiveNote })
              : await runSpecAgent({ promptExec, agent, story, phase: opts.phase, runId, logDir, forcedRetryNote: correctiveNote });
          } catch (err) {
            retryResult = null;
          }
          if (!retryResult || !retryResult.payload) break; // nothing to re-apply — fall through to revert below

          // Undo the rejected attempt's effects before reapplying, so a
          // retry never compounds on top of a rejected write.
          story.acceptanceCriteria = beforeSnapshot.acceptanceCriteria;
          story.description = beforeSnapshot.description;
          story.title = beforeSnapshot.title;
          story.technicalNotes = beforeSnapshot.technicalNotes;
          if (newStories.length > newStoriesCountBefore) {
            newStories.splice(newStoriesCountBefore, newStories.length - newStoriesCountBefore);
          }

          retryResult.payload.runId = runId;
          payload = retryResult.payload;
          if (agent === 'openspec') openspecPayload = payload;
          changes = applySpecChanges(story, payload, newStories, prd, opts.phase, runId, logDir);
          afterSnapshot = captureStorySnapshot(story);

          reviewResult = await reviewPrdChange({
            aiRunnerCmd, profiles, storyId: story.id, changeType: 'spec_pass',
            before: beforeSnapshot, after: afterSnapshot, logDir,
            splitOccurred: changes.splitCount > 0
          });
        }

        if (reviewResult.verdict === 'fail') {
          console.warn(`spec-mode: prd-change-reviewer REJECTED ${agent}'s changes to ${story.id} after ${acReviewAttempts} attempt(s): ${reviewResult.issues.join('; ') || 'no details'} — reverting`);
          story.acceptanceCriteria = beforeSnapshot.acceptanceCriteria;
          story.description = beforeSnapshot.description;
          story.title = beforeSnapshot.title;
          story.technicalNotes = beforeSnapshot.technicalNotes;
          if (newStories.length > newStoriesCountBefore) {
            newStories.splice(newStoriesCountBefore, newStories.length - newStoriesCountBefore);
          }
          changes.acceptanceChanged = false;
          changes.splitCount = 0;
          afterSnapshot = captureStorySnapshot(story);
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'reviewer_rejected', decision: 'rejected', details: { agent, attempts: acReviewAttempts, reasons: reviewResult.issues } });
        } else {
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'reviewer_accepted', decision: 'accepted', details: { agent, attempts: acReviewAttempts } });
        }

        logGuardedStepRetry(logDir, {
          timestamp: new Date().toISOString(),
          step: 'ac-review',
          storyId: story.id,
          runId,
          agent,
          attempts: acReviewAttempts,
          outcome: reviewResult.verdict === 'fail' ? 'reverted' : 'pass',
          reason: (reviewResult.issues || []).join('; '),
          // content_quality is the only vocabulary entry here — reviewPrdChange's
          // verdict is itself an LLM judgment call over free-text issues, not a
          // mechanical diff, so it can't be reliably subdivided further without
          // a second LLM call.
          violationTypes: reviewResult.verdict === 'fail' ? ['content_quality'] : []
        });
      }

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
      totalSplitCountForStory += changes.splitCount;
      summary.stats.agents[agent] = (summary.stats.agents[agent] || 0) + 1;
    }

    // Deterministic split-MANDATE check — see checkSplitMandateViolation()'s
    // comment for the live defect this catches: openspec's prompt already
    // said "MANDATORY split required" and was ignored, so a same-run reject-
    // and-retry is needed (user directive, 2026-07-06: "check number of ACs —
    // if > 12 then reject and send back to coordinator" — this is the
    // deterministic gate, not just another round of unenforced prose).
    let mandateCheck = checkSplitMandateViolation(originalStorySnapshot, totalSplitCountForStory);
    if (mandateCheck.violated) {
      console.warn(
        `spec-mode: split MANDATE violation for ${story.id}: ${mandateCheck.reason} ` +
        `— openspec was instructed to split but did not; forcing an immediate retry`
      );
      appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'pending_retry', details: { reason: mandateCheck.reason } });
      const forcedRetryNote =
        `CRITICAL — YOUR PREVIOUS OUTPUT VIOLATED A MANDATORY RULE. This story ${mandateCheck.reason}, ` +
        `which REQUIRES a split, and you did not produce one. This is NOT optional and NOT a suggestion. ` +
        `You MUST output a non-empty "splitStories" array in your response this time.`;
      summary.stats.agentAttempts += 1;
      let retryResult;
      try {
        retryResult = await runSpecAgent({ promptExec, agent: 'openspec', story, phase: opts.phase, runId, logDir, forcedRetryNote });
      } catch (err) {
        retryResult = null;
      }
      if (retryResult && retryResult.payload) {
        retryResult.payload.runId = runId;
        const childrenCountBefore = newStories.length;
        const retryChanges = applySpecChanges(story, retryResult.payload, newStories, prd, opts.phase, runId, logDir);
        summary.stats.splits += retryChanges.splitCount;
        totalSplitCountForStory += retryChanges.splitCount;

        // Root cause of a live cascade defect (2026-07-06): a split "counts"
        // by splitCount alone, but a LAZY/non-compliant split — every child
        // inheriting the FULL original acceptanceCriteria array verbatim,
        // instead of an actual partition — technically produces
        // splitStories.length > 0 while leaving every child STILL over the
        // AC threshold. Each child then re-triggers its OWN split-mandate
        // violation on its own turn, recursively splitting again and again
        // until the max-split-depth cap — SKY-001 (a simple scaffold story)
        // cascaded into 4 stories in one run this way. Verify the CHILDREN
        // are actually compliant, not just that splitCount > 0. If they are
        // NOT, do not attempt a second forced retry (that's how the cascade
        // started) — fall back to flagging, same as any other unresolved
        // violation.
        const newChildren = newStories.slice(childrenCountBefore).map((ns) => ns.story);
        const nonCompliantChildren = newChildren.filter((child) => storyRequiresSplit(captureStorySnapshot(child)).required);
        mandateCheck = checkSplitMandateViolation(originalStorySnapshot, totalSplitCountForStory);
        if (!mandateCheck.violated && nonCompliantChildren.length > 0) {
          console.warn(
            `spec-mode: forced retry for ${story.id} produced a LAZY split — ${nonCompliantChildren.map((c) => c.id).join(', ')} ` +
            `still violate(s) the split mandate (likely inherited the full AC list verbatim) — treating as unresolved, not retrying again`
          );
          mandateCheck = { violated: true, reason: `split produced non-compliant child/children: ${nonCompliantChildren.map((c) => c.id).join(', ')}` };
        }
        if (!mandateCheck.violated) {
          console.log(`spec-mode: forced retry resolved the split MANDATE violation for ${story.id}`);
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'resolved', details: { reason: mandateCheck.reason } });
        } else {
          console.warn(
            `spec-mode: forced retry did NOT resolve the split MANDATE violation for ${story.id} ` +
            `— flagging for the next specification pass`
          );
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'unresolved', details: { reason: mandateCheck.reason } });
        }
      } else {
        summary.stats.agentFailures += 1;
        console.warn(`spec-mode: forced split-mandate retry produced no parsable output for ${story.id} — flagging for the next specification pass`);
        appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'unresolved', details: { reason: mandateCheck.reason } });
      }
    }

    const specStatus = appliedAgents.length ? 'completed' : 'assigned';
    const existingSpec = story.specification || {};
    const existingReview = existingSpec.coordinatorReview || {};
    const existingFlags = Array.isArray(existingReview.flags) ? existingReview.flags : [];
    story.specification = {
      ...existingSpec,
      runId,
      assignedAgents: assigned.agents,
      coordinatorNotes: assigned.notes,
      status: specStatus,
      updatedAt: new Date().toISOString(),
      appliedAgents,
      agentContributions,
      ...(mandateCheck.violated
        ? {
            coordinatorReview: {
              ...existingReview,
              flags: [...existingFlags, `MANDATORY split was required (${mandateCheck.reason}) but was not performed — split this story now`]
            }
          }
        : {})
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

    // Token-budget pass: check each split child created this story iteration.
    // If a child's estimated baseline prompt exceeds the budget, request a
    // further split via a fresh openspec call — same forced-retry shape as the
    // split-mandate gate above, but triggered by token count rather than AC count.
    // Respects the global SPEC_MAX_SPLIT_DEPTH cap (no infinite re-split chains).
    const _tokenBudget = parseInt(process.env.EPAM_TOKEN_BUDGET_PER_STORY || '100000', 10);
    const _contractDir = path.join(path.dirname(prdPath), '.contracts');
    const _tokenSplitMax = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
    const _childrenThisStory = newStories.filter((ns) => ns.parentId === story.id);
    for (const { story: child } of _childrenThisStory) {
      const _est = estimateStoryTokens(child, _contractDir);
      if (_est <= _tokenBudget) continue;
      if (splitDepth(child, prd) >= _tokenSplitMax) {
        console.warn(
          `spec-mode: token-budget: ${child.id} ~${Math.round(_est / 1000)}K tokens but at max split depth — proceeding at risk`
        );
        continue;
      }
      console.warn(
        `spec-mode: token-budget: ${child.id} ~${Math.round(_est / 1000)}K tokens (budget ${Math.round(_tokenBudget / 1000)}K) — requesting further split`
      );
      const _tokenNote =
        `IMPORTANT — Story ${child.id} is estimated at ~${Math.round(_est / 1000)}K tokens, ` +
        `exceeding the ${Math.round(_tokenBudget / 1000)}K token budget. ` +
        `It has ${(child.acceptanceCriteria || []).length} ACs. ` +
        `YOU MUST split it further, separating distinct concerns (e.g. frontend/template ` +
        `work from build/configuration work), targeting ≤8 ACs and ≤${Math.round(_tokenBudget / 1000)}K tokens per child.`;
      summary.stats.agentAttempts += 1;
      let _tokenRetry = null;
      try {
        _tokenRetry = await runSpecAgent({
          promptExec, agent: 'openspec', story: child,
          phase: opts.phase, runId, logDir, forcedRetryNote: _tokenNote
        });
      } catch (err) { _tokenRetry = null; }
      if (_tokenRetry?.payload?.splitStories?.length) {
        _tokenRetry.payload.runId = runId;
        const _trc = applySpecChanges(child, _tokenRetry.payload, newStories, prd, opts.phase, runId, logDir);
        summary.stats.splits += _trc.splitCount;
        totalSplitCountForStory += _trc.splitCount;
        if (_trc.splitCount > 0) {
          console.log(`spec-mode: token-budget retry split ${child.id} into ${_trc.splitCount} child/children`);
        }
      }
    }
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
    // Remove successfully-delegated parents from the active phase list — every
    // parentId here had its children genuinely accepted (rejected splits are
    // spliced out of newStories earlier, in applySpecChanges), so its own
    // status was just marked 'deprecated' above. Leaving it in
    // implementationOrder made downstream consumers (TC writer, the main
    // implementation loop) treat it as still-active work with real source
    // files, when its implementation is now entirely delegated to children.
    const delegatedParentIds = new Set(Object.keys(parentInsertOffsets));
    const order = prd.implementationOrder?.[opts.phase];
    if (Array.isArray(order)) {
      prd.implementationOrder[opts.phase] = order.filter((id) => !delegatedParentIds.has(id));
    }

    // Wire test-child dependencies onto impl siblings from the SAME split —
    // must run after ALL children for a parent are inserted so basename
    // matching sees every sibling, not just the first processed.
    const byParentForWiring = new Map();
    for (const insert of newStories) {
      if (!byParentForWiring.has(insert.parentId)) byParentForWiring.set(insert.parentId, []);
      byParentForWiring.get(insert.parentId).push(insert.story);
    }
    const wiringOrder = prd.implementationOrder?.[opts.phase];
    for (const siblings of byParentForWiring.values()) {
      wireSplitSiblingDependencies(siblings, prd);
      reorderSiblingsByDependency(siblings, wiringOrder);
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

    const reviewPrompt = `${specCoordinatorProfile ? specCoordinatorProfile + '\n\n' : ''}You are the EPAM CLI specification coordinator reviewing the completed spec outputs for phase ${opts.phase}.

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
  // Fallback default MUST stay within this pipeline's configured model ladder
  // (MiniMax/qwen-routed models only — Anthropic models are never permitted
  // here). A prior default of 'anthropic/claude-sonnet-4-6' meant ANY
  // invocation that forgot to export ORCH_UPGRADE_MODEL (e.g. a hand-rolled
  // launcher that didn't replicate tier3-travel-app-run.sh's full env-var
  // set) silently got an Anthropic model assigned — and because
  // buildKnownValidModels() below includes whatever this resolves to,
  // isValidModelString() accepted it as "known valid" by construction, so no
  // validation ever caught it (found live 2026-07-13: SKY-001 assigned
  // anthropic/claude-sonnet-4-6, failed 8/8 attempts, aborted the phase).
  const upgradeModel = process.env.ORCH_UPGRADE_MODEL || 'MiniMax-M3';
  const miniModel    = process.env.ORCH_MINI_MODEL    || 'MiniMax-M2.5';
  // Ceiling model for veryHighComplexity stories — "the most appropriate
  // high model," reusing the SAME strongest-configured-model concept the
  // Rung3+ watchdog fallback already uses (EPAM_FINAL_FALLBACK_MODEL), so
  // there's one source of truth for "what is our ceiling model" rather than
  // two independently-configured ceilings that could drift apart. A
  // dedicated EPAM_VERY_HIGH_COMPLEXITY_MODEL override exists for projects
  // that want a different ceiling here than the watchdog-timeout fallback.
  const veryHighModel    = process.env.EPAM_VERY_HIGH_COMPLEXITY_MODEL    || process.env.EPAM_FINAL_FALLBACK_MODEL    || upgradeModel;
  const veryHighProvider = process.env.EPAM_VERY_HIGH_COMPLEXITY_PROVIDER || process.env.EPAM_FINAL_FALLBACK_PROVIDER || '';
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
      ruleRecommendation: signals.veryHighComplexity ? veryHighModel : (signals.needsUpgrade ? upgradeModel : story.model),
      ruleUpgrade: signals.needsUpgrade,
      ruleReason: signals.reason || 'no upgrade signal detected',
      veryHighComplexity: signals.veryHighComplexity,
      veryHighReason: signals.veryHighReason,
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

    const modelReviewPrompt = `${specCoordinatorProfile ? specCoordinatorProfile + '\n\n' : ''}You are the EPAM CLI model assignment coordinator for phase ${opts.phase}.

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

    let llmDecisions = null;
    try {
      llmDecisions = await runAgentForJson(
        promptExec,
        modelReviewPrompt,
        TOOL_MODEL_REVIEW,
        'MODEL_REVIEW',
        path.join(logDir, `spec-model-review-${opts.phase}.log`),
        'items'
      );
    } catch (err) { llmDecisions = null; }
    if (Array.isArray(llmDecisions)) {
      // Tier label → canonical model ID (LLM sometimes echoes the tier label instead of a real model string)
      const TIER_LABEL_MAP = {
        'standard-tier': upgradeModel,
        'mini-tier':     miniModel,
        'nano-tier':     miniModel,
        'premium-tier':  process.env.ORCH_PREMIUM_MODEL || upgradeModel,
      };
      const resolveTierLabel = (m) => (m && TIER_LABEL_MAP[m]) ? TIER_LABEL_MAP[m] : m;

      const knownValidModels = buildKnownValidModels(upgradeModel, miniModel);
      const isValidModel = (m, currentModel) => isValidModelString(m, currentModel, knownValidModels);

      const decisionMap = new Map();
      llmDecisions.forEach((d) => { if (d && d.storyId) decisionMap.set(d.storyId, d); });
      finalAssessments = finalAssessments.map((fa) => {
        // veryHighComplexity is a deterministic, code-level classification —
        // the LLM coordinator has no concept of "ceiling model, skip the
        // ladder" and could talk itself into downgrading a story that
        // genuinely needs it (same "code-level checks > LLM persuasion"
        // principle already applied elsewhere in this pipeline). Bypass
        // Pass B entirely for these stories; the rule-based ceiling
        // assignment from Pass A is final.
        if (fa.veryHighComplexity) return fa;
        const decision = decisionMap.get(fa.storyId);
        if (!decision) return fa;
        const rawModel = decision.finalModel && decision.finalModel !== 'keep-current'
          ? decision.finalModel
          : fa.ruleRecommendation;
        let llmModel = resolveTierLabel(rawModel);
        let rejectedInvalidModel = false;
        if (!isValidModel(llmModel, fa.currentModel)) {
          console.warn(
            `spec-mode: LLM model review for ${fa.storyId} returned unrecognized model "${llmModel}" — ` +
            `ignoring and using rule-based recommendation "${fa.ruleRecommendation}" instead`
          );
          llmModel = fa.ruleRecommendation;
          rejectedInvalidModel = true;
        }
        return {
          ...fa,
          finalModel: llmModel,
          llmOverride: decision.override === true && !rejectedInvalidModel,
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
    // veryHighComplexity: mark skipLadder regardless of whether the model
    // string itself changed (e.g. it was already assigned the ceiling
    // model by an earlier pass) — the flag is what tells claude.sh's
    // InferenceLadder to stop reassigning models on retry, not the model
    // value alone.
    if (fa.veryHighComplexity && !story.skipLadder) {
      story.skipLadder = true;
      console.log(`spec-mode: ${story.id} marked skipLadder=true (${fa.veryHighReason})`);
    }
    if (fa.finalModel !== story.model) {
      const prev = story.model;
      story.model = fa.finalModel;
      // Keep aiProvider in sync with the new model — see resolveModelProvider's
      // docstring for the live bug this fixes (stale provider + new model
      // silently misrouting requests, causing an indefinite hang).
      const newProvider = resolveModelProvider(fa.finalModel) || (fa.veryHighComplexity ? veryHighProvider : '');
      if (newProvider && newProvider !== story.aiProvider) {
        const prevProvider = story.aiProvider;
        story.aiProvider = newProvider;
        console.log(
          `spec-mode: provider set ${story.id}: ${prevProvider} → ${newProvider} (model changed to ${fa.finalModel})`
        );
      }
      if (!story.specification) story.specification = {};
      story.specification.modelUpgrade = {
        from: prev,
        to: fa.finalModel,
        ruleSignals: fa.signals,
        ruleReason: fa.ruleReason,
        llmOverride: fa.llmOverride,
        llmReason: fa.llmReason,
        llmConfidence: fa.llmConfidence || null,
        veryHighComplexity: fa.veryHighComplexity || false,
        veryHighReason: fa.veryHighReason || '',
        upgradedAt: new Date().toISOString()
      };
      modelChanges.push({ storyId: story.id, from: prev, to: fa.finalModel, llmOverride: fa.llmOverride, veryHighComplexity: fa.veryHighComplexity || false });
      console.log(`spec-mode: model set ${story.id}: ${prev} → ${fa.finalModel}${fa.llmOverride ? ' [LLM override]' : ''}${fa.veryHighComplexity ? ' [VERY HIGH COMPLEXITY — ceiling model, skipLadder]' : ''}`);
    }
  }
  if (modelChanges.length > 0) {
    summary.stats.modelUpgrades = modelChanges;
  }

  // Story-ID-loss invariant — see assertNoStoryIdsLost's docstring.
  assertNoStoryIdsLost(_initialStoryIds, new Set((prd.stories || []).map((s) => s.id)), 'run()');

  // Atomic write (write to a temp file, then rename): writeFileSync alone
  // truncates the target before writing, so a kill mid-write leaves the PRD
  // empty/corrupted — the same class of incident found live 2026-07-11 (a
  // "Bad control character in string literal" PRD corruption). Locked
  // against concurrent writers (e.g. a parallel worktree story patching the
  // same PRD) so two writes can't interleave at the disk-write moment.
  const _prdLockPath = `${prdPath}.lock`;
  acquireFileLock(_prdLockPath);
  try {
    const _tmpPrdPath = `${prdPath}.tmp`;
    fs.writeFileSync(_tmpPrdPath, JSON.stringify(prd, null, 2));
    fs.renameSync(_tmpPrdPath, prdPath);
  } finally {
    releaseFileLock(_prdLockPath);
  }
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
async function runSpecAgent({ promptExec, agent, story, phase, runId, logDir, forcedRetryNote }) {
  const acCount = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0;
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

  // Uses the SAME threshold function as checkSplitMandateViolation() (below)
  // so the prompt warning and the deterministic post-hoc check can never
  // drift apart — one is prose telling the agent what's required, the other
  // verifies the agent actually did it.
  const splitRequirement = storyRequiresSplit(captureStorySnapshot(story));
  const splitWarning = splitRequirement.required
    ? `\nNOTE: This story ${splitRequirement.reason} — MANDATORY split required (see SPLIT RULES below).`
    : '';

  // Surface any prior coordinator flags so openspec addresses them rather than rubber-stamping
  const priorFlags = story.specification?.coordinatorReview?.flags;
  const priorNotes = story.specification?.coordinatorReview?.reviewNotes;
  const priorGapsBlock = (Array.isArray(priorFlags) && priorFlags.length > 0)
    ? `\n\nPRIOR COORDINATOR FLAGS (you MUST address each one — do NOT declare the spec complete without resolving these):\n${priorFlags.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n${priorNotes ? `\nAdditional context from prior review: ${priorNotes.slice(0, 500)}` : ''}`
    : '';

  // Forced-retry note goes at the VERY TOP — highest-salience position in the
  // prompt (primacy). Root cause this addresses (found live, 2026-07-06):
  // the mid-prompt "MANDATORY split required" NOTE was already present on the
  // FIRST attempt and still got ignored. A same-session forced retry needs
  // maximum prominence, not just a repeat of the same mid-prompt phrasing.
  const forcedRetryBlock = forcedRetryNote ? `${forcedRetryNote}\n\n` : '';

  const sembleContext = fetchSembleContext(story);

  // Brownfield archaeology block — injected for openspec only when EPAM_BROWNFIELD=1.
  // openspec must identify the existing change site before writing any AC.
  // locationHint feeds directly into the story agent's context so it opens the right file.
  const isBrownfieldOpenspec = process.env.EPAM_BROWNFIELD === '1' && agent === 'openspec';
  const brownfieldArchaeologyBlock = isBrownfieldOpenspec
    ? `\n\nBROWNFIELD INVESTIGATION (mandatory — complete before writing any AC):\nThis is an existing codebase. Identify the specific file(s) and function(s) that currently handle the behavior described in this story. Set the "locationHint" field in your output to: [{"file":"<repo-relative path>","function":"<function name>","reason":"<why this is the fix site>"}]. ACs must describe changes to those specific locations — do not propose new files, services, or abstractions.\n`
    : '';
  const locationHintSchemaLine = isBrownfieldOpenspec
    ? `\n  "locationHint":[{"file":"path/relative/to/repo","function":"functionName","reason":"why this is the fix site"}],`
    : '';

  const prompt = `${forcedRetryBlock}You are the ${agent} specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.${splitWarning}${priorGapsBlock}${sembleContext}${brownfieldArchaeologyBlock}
Generate refined acceptance criteria, optionally updated title/description, and split stories where required. Output raw JSON only (no XML tags, no markdown fences, no preamble) using this schema:
{
  "storyId":"${story.id}",
  "agent":"${agent}",
  "notes":"context",
  "acceptanceCriteria":["..."],
  "description":"...",
  "title":"...",${locationHintSchemaLine}
  "splitStories":[{"id":"optional","title":"...","description":"...","acceptanceCriteria":["..."],"agentRole":"...","technicalNotes":{"files":[]}}]
}
Use existing text when no change is needed.

SPLIT RULES (mandatory, not optional — enforce these before refining AC):
1. AC count > 12 → you MUST propose a split. Target ≤8 ACs per split child. Never leave a story with >12 ACs unsplit.
2. Both implementation files AND test files in technicalNotes.files → split into one impl child (non-test files) and one test child (*.test.ts files). Assign agentRole "typescript-engineer" to impl, "test-engineer" to test.
3. 3+ independent deliverable modules with no shared exports (e.g. client.ts, server.ts, cli.ts all in same story) → split per concern. Each split gets the files it owns.
4. External API discovery + implementation in same story → split: first child discovers/documents the API contract, second child implements against that contract.
5. technicalNotes.files contains BOTH frontend/template files (*.html, *.css, *.scss, *.jsx, *.tsx, *.vue, *.svelte) AND build/tooling files (vite.config.*, webpack.config.*, rollup.config.*, package.json, Makefile, Dockerfile, *.sh) → split: one child owns the frontend/template files, one child owns the build/tooling files. These have different runtime roles and different owners — bundling them causes token bloat and diffuse responsibility.
6. Story covers multiple independent runtime roles in the same deliverable (e.g. HTTP server AND CLI binary AND HTML dashboard) → split by runtime role, one child per runtime target. Each child's agentRole should match what it produces (typescript-engineer for application code, test-engineer for test-only files).
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
async function runSpeckitReview({ promptExec, story, openspecOutput, phase, runId, logDir, forcedRetryNote }) {
  // Same primacy placement as runSpecAgent's forcedRetryBlock — highest-salience
  // position in the prompt for a same-session forced retry.
  const forcedRetryBlock = forcedRetryNote ? `${forcedRetryNote}\n\n` : '';
  const prompt = `${forcedRetryBlock}You are the speckit specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.

You are reviewing and building on the openspec agent's output for this story.
Your role is COLLABORATIVE — you are NOT starting from scratch. Instead:
1. Review openspec's proposed acceptance criteria for testability and completeness
2. Add missing edge-case, error-handling, security, and accessibility criteria
3. Flag any AC that are vague, untestable, or overlapping
4. Splitting is openspec's decision alone — you do NOT split stories. If openspec already split
   this story, do NOT include a "splitStories" field in your output at all (it will be ignored if
   you do). Review and refine the acceptanceCriteria openspec gave you for the UNSPLIT story as
   normal; per-child refinement of an already-split story's children happens on a later turn, not
   here.
5. Do NOT remove or duplicate openspec's good work — build on it

━━━ WHAT-NOT-HOW RULE (MANDATORY) ━━━
Every AC must describe an OBSERVABLE OUTCOME (what a test can verify from outside the code),
NOT an implementation instruction. If an AC names vi.mock, jest.fn, mockReturnValue,
mockResolvedValue, import statements, or require() calls, REPLACE it with a
Given/When/Then behaviour statement. Never tell the implementer which library or mock pattern to use.

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
- "splitStories": ALWAYS omit this field. Splitting is openspec's decision alone — never propose
  split children of your own, even if openspec already split this story.
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

// Lightweight token-budget estimate for a story before it enters the executor.
// Measures the baseline prompt footprint (ACs × density + file entries + contract
// sizes) without running the executor. Intentionally conservative — accumulated
// context from tool calls is unknowable pre-execution, but the baseline is the
// dominant factor for over-budget stories.
const ESTIMATE_BASE = 2000;
const ESTIMATE_PER_AC = 150;
const ESTIMATE_PER_TC = 300;    // ~2 TCs per AC × 150 tokens each
const ESTIMATE_PER_FILE = 100;
const ESTIMATE_BYTES_PER_TOKEN = 4;

function estimateStoryTokens(story, contractDir) {
  const acCount = (story.acceptanceCriteria || []).length;
  const fileCount = (story.technicalNotes?.files || []).length;
  let contractTokens = 0;
  for (const depId of (story.dependencies || [])) {
    try {
      contractTokens += Math.ceil(
        fs.statSync(path.join(contractDir, `${depId}.md`)).size / ESTIMATE_BYTES_PER_TOKEN
      );
    } catch { /* contract not yet written — skip */ }
  }
  return ESTIMATE_BASE
    + (acCount * ESTIMATE_PER_AC)
    + (acCount * ESTIMATE_PER_TC)
    + (fileCount * ESTIMATE_PER_FILE)
    + contractTokens;
}

// Split MANDATE thresholds — shared by the prompt warning (runSpecAgent) and the
// deterministic post-hoc check below (checkSplitMandateViolation), so the two
// can never drift apart. Fully generic: no project/domain names, just AC count
// and impl/test file shape — applies identically to any project's stories.
const SPLIT_MANDATE_AC_THRESHOLD = 12;

function storyRequiresSplit(snapshot) {
  const acCount = Array.isArray(snapshot.acceptanceCriteria) ? snapshot.acceptanceCriteria.length : 0;
  const files = snapshot.technicalNotes?.files || [];
  const testFiles = files.filter((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
  const implFiles = files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
  if (acCount > SPLIT_MANDATE_AC_THRESHOLD) {
    return { required: true, reason: `${acCount} acceptance criteria (> ${SPLIT_MANDATE_AC_THRESHOLD})` };
  }
  if (testFiles.length > 0 && implFiles.length > 0) {
    return { required: true, reason: `combines ${implFiles.length} implementation file(s) and ${testFiles.length} test file(s)` };
  }
  return { required: false, reason: '' };
}

// Root cause this catches (found live, 2026-07-06): openspec's prompt already
// says "MANDATORY split required" whenever storyRequiresSplit() is true — but
// that's pure prose, never verified afterward. A story meeting the mandate can
// silently stay unsplit for its entire lifetime with zero visible signal,
// because the ONLY existing split check (validateSplitFileCoherence, above)
// only fires when a split DID happen and is incoherent — it has nothing to
// say about a split that should have happened but never did. Confirmed live:
// a story with 15 ACs and combined impl+test files went through 3 separate
// openspec passes across 2 full pipeline runs and was never split, exhausting
// its entire model-escalation ladder on a single overloaded story instead.
// Returns {violated, reason} — detection only (Option D pattern: deterministic
// detection, not a silent auto-split, since auto-splitting requires domain
// judgment about where the split boundary goes).
function checkSplitMandateViolation(beforeSnapshot, splitCountAfter) {
  if (splitCountAfter > 0) {
    return { violated: false, reason: '' };
  }
  const { required, reason } = storyRequiresSplit(beforeSnapshot);
  if (!required) {
    return { violated: false, reason: '' };
  }
  return { violated: true, reason };
}

// ── TC-fact-density split mandate (test stories) ────────────────────────────
//
// Root cause this fixes (found live, 2026-07-14, tier3-travel-app run):
// storyRequiresSplit()/checkSplitMandateViolation() above only ever see AC
// count and impl/test file shape — both known at SPEC-PASS time (Step 0),
// before any implementation has run. But a pure test story's REAL
// generation load comes from testCriteria.facts — exact-match behavioral
// facts the TC writer only discovers post-impl, right before the test
// story itself executes (see lib/tc-writer-gate.sh). SKY-003-test had a
// modest 8 ACs (well under SPLIT_MANDATE_AC_THRESHOLD) but 20 TC facts + 19
// bannedPatterns crammed into ONE test file — every model at every
// escalation rung, up to the ceiling, produced widespread syntax
// corruption (30+ tsc errors) on it, 8/8 attempts. The AC-count mandate
// structurally cannot see this; it needs its own, TC-fact-density-based
// mandate, checked at the one point density is actually known.
//
// EPAM_TC_FACTS_SPLIT_THRESHOLD (default 30): facts count alone, since
// that's what makes ONE file too large to write correctly, independent of
// how many bannedPatterns rules also apply (those are global constraints
// copied to every split child unchanged, not something to partition).
const TC_FACTS_SPLIT_THRESHOLD = parseInt(process.env.EPAM_TC_FACTS_SPLIT_THRESHOLD || '30', 10);

function checkTcFactDensityMandate(factsCount, threshold = TC_FACTS_SPLIT_THRESHOLD) {
  const count = Number(factsCount) || 0;
  if (count > threshold) {
    return { violated: true, reason: `${count} testCriteria.facts (> ${threshold}) on a single test file — split into multiple test stories` };
  }
  return { violated: false, reason: '' };
}

// splitTestStoryByFacts <story> <prd> <phase> [maxFactsPerChild]
// Partitions a pure-test story's testCriteria.facts into N children, each
// owning a distinct test file covering its own subset of facts. Unlike
// applySpecChanges()'s AC-based split (which needs an LLM to decide WHERE
// the split boundary goes, since AC semantics require judgment), a facts
// array has no such ambiguity — each fact is an independent, already-atomic
// assertion, so a purely mechanical even partition is safe and requires no
// LLM involvement (same "deterministic code-level action, not LLM
// persuasion" principle as the rest of this pipeline's self-heal layer).
//
// Mutates `prd` in place: marks the parent deprecated+completed (delegated,
// same convention as applySpecChanges' AC-split parent handling) and
// splices the new child IDs into prd.implementationOrder[phase] at the
// parent's former position. Returns { splitCount, childIds } — {0, []} if
// the story isn't eligible (not a pure test story, or already split/
// deprecated).
function splitTestStoryByFacts(story, prd, phase, maxFactsPerChild = TC_FACTS_SPLIT_THRESHOLD) {
  if (!story || story.status === 'deprecated') return { splitCount: 0, childIds: [] };
  const files = story.technicalNotes?.files || [];
  const isPureTestStory = files.length > 0 && files.every((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
  if (!isPureTestStory || files.length !== 1) return { splitCount: 0, childIds: [] };

  const facts = Array.isArray(story.testCriteria?.facts) ? story.testCriteria.facts : [];
  if (facts.length === 0) return { splitCount: 0, childIds: [] };

  const perChild = Math.max(1, Number(maxFactsPerChild) || TC_FACTS_SPLIT_THRESHOLD);
  const childCount = Math.ceil(facts.length / perChild);
  if (childCount <= 1) return { splitCount: 0, childIds: [] };

  const testFile = files[0];
  const dotIdx = testFile.lastIndexOf('.test.');
  const isSpec = dotIdx === -1;
  const splitPoint = isSpec ? testFile.lastIndexOf('.spec.') : dotIdx;
  const ext = isSpec ? '.spec.ts' : '.test.ts';
  const base = testFile.slice(0, splitPoint);

  const childIds = [];
  const newChildren = [];
  for (let i = 0; i < childCount; i++) {
    const childId = `${story.id}-tc${i + 1}`;
    const factSlice = facts.slice(i * perChild, (i + 1) * perChild);
    const child = JSON.parse(JSON.stringify(story));
    child.id = childId;
    child.title = `${story.title} (part ${i + 1}/${childCount})`;
    child.status = 'pending';
    child.completed = false;
    child.technicalNotes = { ...story.technicalNotes, files: [`${base}.tc${i + 1}${ext}`] };
    child.testCriteria = {
      ...story.testCriteria,
      facts: factSlice,
    };
    child.specification = {
      ...(story.specification || {}),
      createdFrom: story.id,
      createdAt: new Date().toISOString(),
      splitOrigin: 'tc-density-split',
      splitDepth: ((story.specification && story.specification.splitDepth) || 0) + 1,
    };
    childIds.push(childId);
    newChildren.push(child);
  }

  prd.stories.push(...newChildren);
  story.acceptanceCriteria = [`Delegated to TC-density split children: ${childIds.join(', ')}`];
  story.status = 'deprecated';
  story.completed = true;

  const order = prd.implementationOrder?.[phase];
  if (Array.isArray(order)) {
    const idx = order.indexOf(story.id);
    if (idx !== -1) {
      order.splice(idx, 1, ...childIds);
    } else {
      order.push(...childIds);
    }
  }

  console.log(`spec-mode: TC-fact-density split — ${story.id} (${facts.length} facts) → ${childIds.join(', ')} (${perChild} facts/child max)`);
  return { splitCount: childIds.length, childIds };
}

// Root cause this fixes (found live, 2026-07-06, tier3-full-run-18): a split
// child whose files are ALL test files (e.g. SKY-002-TEST, owning only
// client.test.ts) kept the PARENT's implementation-oriented agentRole
// (typescript-engineer) instead of a test-oriented role. The only existing
// correction mechanism was an LLM instruction buried in the Step 0.5 "skill
// assessment" prompt ("if all files match *.test.ts, update agentRole to
// test-engineer") — and it silently failed to apply to EVERY split child
// created this run, not just one. A rule this simple (file-extension pattern
// -> role) should never depend on an LLM correctly executing free-text
// instructions.
//
// Deliberately NOT hardcoding a role name here — agent roles are project-
// defined and dynamic (profiles.json is generated per-project, not fixed).
// The correct role name and the pattern that identifies "this is a test-only
// story" both come from the project's own .epam/contract-generation.json
// (testFilePattern / testFileAgentRole), the same "config supplies stack
// knowledge, engine has none" convention already used for dependency-check.json
// and elsewhere in this file. If the project hasn't supplied testFileAgentRole,
// this is a no-op — the child simply keeps whatever role it already had.
function correctSplitChildAgentRoleIfTestOnly(prd, story) {
  const outputDir = prd.project?.outputDir;
  if (!outputDir) return;
  const configPath = path.join(outputDir, '.epam', 'contract-generation.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  if (!cfg.testFileAgentRole || !cfg.testFilePattern) return;
  const files = story.technicalNotes?.files;
  if (!Array.isArray(files) || files.length === 0) return;
  const testFileRe = new RegExp(cfg.testFilePattern);
  const allTestFiles = files.every((f) => testFileRe.test(f));
  if (allTestFiles) {
    story.agentRole = cfg.testFileAgentRole;
  }
}

// wireSplitSiblingDependencies(siblings, prd)
// Root cause this fixes (found live, 2026-07-09, tier3-travel-app run): a
// split child's `dependencies` array comes straight from the LLM's own split
// proposal — nothing deterministically cross-references a test-only sibling
// to its impl sibling from the SAME split. Downstream, claude.sh's
// dependency-contract injection (build_implementation_prompt,
// run_failure_analyst) and are_dependencies_satisfied() gate ONLY on
// `.dependencies`/`.technicalNotes.dependsOn` — so a test child never
// receives its impl sibling's real (regex-extracted) exported signatures, on
// its first attempt OR any retry. Confirmed live: SKY-003-test/-test-1 and
// SKY-004-test all had `dependencies: []` despite an obvious impl sibling
// (same `specification.createdFrom`), and burned 7+ healing cycles guessing
// at shifting surface symptoms instead of ever seeing the real contract.
//
// Uses the SAME basename-matching convention already proven live in
// post-impl-tc-writer.sh's peer-file search (strip a test file's suffix,
// strip a candidate impl file's extension, match on the resulting stem) —
// generalized to read `testFilePattern`/`sourceExtensions` from the
// project's existing `.epam/contract-generation.json` (both keys already
// exist in every scaffolded project's config; zero new schema) instead of
// hardcoding '.test.ts'/'.ts', so this stays stack-agnostic like every other
// consumer of that config file.
function wireSplitSiblingDependencies(siblings, prd) {
  const outputDir = prd.project?.outputDir;
  if (!outputDir || !Array.isArray(siblings) || siblings.length < 2) return;
  const configPath = path.join(outputDir, '.epam', 'contract-generation.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  if (!cfg.testFilePattern || !Array.isArray(cfg.sourceExtensions) || !cfg.sourceExtensions.length) return;
  const testFileRe = new RegExp(cfg.testFilePattern);
  const exts = [...cfg.sourceExtensions].sort((a, b) => b.length - a.length);

  const stemOf = (filePath, isTest) => {
    const base = filePath.split('/').pop();
    if (isTest) return base.replace(testFileRe, '');
    for (const ext of exts) {
      if (base.endsWith(ext)) return base.slice(0, -ext.length);
    }
    return base;
  };

  for (const testSibling of siblings) {
    const files = testSibling.technicalNotes?.files;
    if (!Array.isArray(files) || files.length === 0) continue;
    if (!files.every((f) => testFileRe.test(f))) continue; // not a pure test-only child
    const testStems = new Set(files.map((f) => stemOf(f, true)));
    const deps = new Set(Array.isArray(testSibling.dependencies) ? testSibling.dependencies : []);
    let wired = false;
    for (const implSibling of siblings) {
      if (implSibling === testSibling) continue;
      const implFiles = implSibling.technicalNotes?.files;
      if (!Array.isArray(implFiles) || implFiles.length === 0) continue;
      if (implFiles.some((f) => testFileRe.test(f))) continue; // skip other test siblings
      const implStems = implFiles.map((f) => stemOf(f, false));
      if (implStems.some((s) => testStems.has(s)) && !deps.has(implSibling.id)) {
        deps.add(implSibling.id);
        wired = true;
      }
    }
    if (wired) {
      testSibling.dependencies = [...deps];
      console.log(`spec-mode: wired ${testSibling.id}.dependencies -> [${[...deps].join(', ')}] (deterministic sibling match, createdFrom=${testSibling.specification?.createdFrom})`);
    }
  }
}

// reorderSiblingsByDependency(siblings, order)
// Required corollary of wireSplitSiblingDependencies: are_dependencies_satisfied()
// (claude.sh) hard-gates a story on its dependencies' `.completed==true`, and
// the main Step 1 loop executes strictly in implementationOrder[phase] order.
// Newly wiring a dependency onto a sibling ordered BEFORE its dependency would
// introduce a new hard failure that doesn't exist today — this only reorders
// IDs already present in the same sibling group, moving a dependent story to
// just after its dependency.
function reorderSiblingsByDependency(siblings, order) {
  if (!Array.isArray(order) || !Array.isArray(siblings)) return;
  const siblingIds = new Set(siblings.map((s) => s.id));
  for (const s of siblings) {
    const deps = Array.isArray(s.dependencies) ? s.dependencies : [];
    for (const depId of deps) {
      if (!siblingIds.has(depId)) continue; // only reorder within this sibling group
      const selfIdx = order.indexOf(s.id);
      const depIdx = order.indexOf(depId);
      if (selfIdx !== -1 && depIdx !== -1 && selfIdx < depIdx) {
        order.splice(selfIdx, 1);
        const newDepIdx = order.indexOf(depId);
        order.splice(newDepIdx + 1, 0, s.id);
      }
    }
  }
}

// assertNoStoryIdsLost(beforeIds, afterIds, contextLabel)
// Deterministic invariant check against silent story deletion — JS-side
// mirror of run-agent-orchestration.sh's assert_no_story_ids_lost(). See
// that function's docstring for the live defect this guards against
// (SKY-002/003/004 vanishing entirely from prd.stories[], 2026-07-09).
// beforeIds/afterIds are Sets of story IDs; throws if any ID present in
// beforeIds is absent from afterIds. A GROWING set (new split children) is
// expected and not an error.
function assertNoStoryIdsLost(beforeIds, afterIds, contextLabel) {
  const lost = [...beforeIds].filter((id) => !afterIds.has(id));
  if (lost.length > 0) {
    throw new Error(`spec-mode-runner: STORY-ID-LOSS INVARIANT VIOLATED — story/ies vanished from prd.stories[] during ${contextLabel}: ${lost.join(', ')}`);
  }
}

// resolveModelProvider(model, env)
// JS port of claude.sh's resolve_model_provider() — reads EPAM_MODEL_PROVIDER_MAP
// (pipe-separated "glob-pattern=provider" pairs) and returns the provider for a
// model name via glob matching. Zero hardcoded vendor/model names here, same
// config-driven pattern as the bash original. Returns null when no map is
// configured or no pattern matches (caller keeps the story's existing aiProvider).
//
// Root cause this fixes (found live, 2026-07-07): spec-mode's LLM model-review
// step (below) can override a story's .model field (e.g. moonshotai/kimi-k2 ->
// MiniMax-M3) but never touched .aiProvider — a story ended up with
// aiProvider="qwen" (correct for the OLD model) paired with model="MiniMax-M3"
// (which needs the "minimax" provider), silently sending a MiniMax-native model
// name to the OpenRouter-routed qwen provider. That request never resolves
// correctly and hangs until the pipeline's 600s watchdog kills it — the actual
// root cause of SKY-002-test/SKY-003-test repeatedly stalling with zero output
// in that day's live run, misread at first as a flaky-API/network issue.
function resolveModelProvider(model, env = process.env) {
  const map = env.EPAM_MODEL_PROVIDER_MAP;
  if (!map || !model) return null;
  const globToRegExp = (glob) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  for (const pair of map.split('|')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const pattern = pair.slice(0, eq);
    const provider = pair.slice(eq + 1);
    if (globToRegExp(pattern).test(model)) return provider;
  }
  return null;
}

// Matches the exact placeholder applySpecChanges writes onto a parent story's
// acceptanceCriteria after a successful split (see "Delegated to split
// children:" above). Deliberately a single-purpose string check, not a general
// AC-quality heuristic — this only needs to recognize the ONE deterministic
// template the engine itself produces.
const SPLIT_DELEGATION_AC_PATTERN = /^Delegated to split children: /;

function isSplitDelegationAc(acceptanceCriteria) {
  return (
    Array.isArray(acceptanceCriteria) &&
    acceptanceCriteria.length === 1 &&
    SPLIT_DELEGATION_AC_PATTERN.test(acceptanceCriteria[0])
  );
}

// Root cause this fixes (found live, 2026-07-06, first surfaced only once
// splits started actually succeeding): prd-change-reviewer is a content-quality
// gate that judges a story's AC/description/title rewrite on its own merits —
// it has no way to know "Delegated to split children: X, Y" is a deterministic,
// engine-written placeholder rather than an organically-authored AC, so it
// correctly-by-its-own-lights flags it as "vague and unmeasurable" and reverts
// the ENTIRE change, undoing a structurally-valid split (which applySpecChanges
// had already verified via file coherence, depth, and budget checks) purely
// because of how the resulting placeholder text reads. A split's correctness
// is already deterministically verified elsewhere; asking an LLM to also judge
// the placeholder text it can't recognize as a placeholder is a pure false
// positive, not a real quality signal.
//
// Returns true when the review gate should be skipped for this change because
// a split occurred and the ONLY substantive difference from beforeSnapshot is
// the deterministic delegation marker — description/title/technicalNotes are
// unchanged, so there is nothing else here for a content reviewer to assess.
function isSplitDelegationOnlyChange(beforeSnapshot, afterSnapshot, splitCount) {
  if (!(splitCount > 0)) return false;
  if (!isSplitDelegationAc(afterSnapshot.acceptanceCriteria)) return false;
  return (
    afterSnapshot.description === beforeSnapshot.description &&
    afterSnapshot.title === beforeSnapshot.title &&
    JSON.stringify(afterSnapshot.technicalNotes) === JSON.stringify(beforeSnapshot.technicalNotes)
  );
}

// Detect same-file coherence violations: multiple split children claiming to write
// the same non-test file. Each agent rewrites the file from scratch, so the last
// writer wins and all prior agents' work is silently discarded.
// Returns array of {file, childIds} conflicts. Empty array = coherent.
function validateSplitFileCoherence(children) {
  // Check ALL declared files — test files included. Each split child rewrites its file
  // from scratch (last writer wins), so two children declaring the same .test.ts lose
  // all work from every child except the last one. No exemption for test files.
  const fileToChildren = new Map();
  for (const child of children) {
    const files = (child.technicalNotes?.files || [])
      .filter(f => typeof f === 'string');
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

function applySpecChanges(story, payload, newStories, prd, phaseId, runId, logDir = null) {
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
        // Backfill the PARENT's own external cross-story dependencies (found
        // live, 2026-07-12, tier3-travel-app run): a split child's
        // dependencies come ENTIRELY from the LLM's own per-child split
        // proposal, which frequently omits a dependency the PARENT already
        // deterministically declared. Confirmed live: SKY-003 declared
        // dependencies: ["SKY-002"] (the real Skyscanner API client), but
        // its split child SKY-003-impl ended up with dependencies: [] after
        // the split — it ran immediately with no dependency gate at all,
        // found no real client to import, and self-servingly fabricated a
        // fake stub client via its own dynamic tool just to get ITS OWN
        // deliverables to pass. That wrong stub then poisoned every
        // downstream consumer (SKY-003-test, SKY-004), producing a cascade
        // of misleading "static vs instance method" self-heal diagnoses that
        // were never fixable, because the real problem (SKY-002 never
        // actually succeeded) was invisible the whole time. Merge the
        // parent's own dependencies into EVERY child unconditionally --
        // redundant with wireSplitSiblingDependencies' test-to-impl wiring
        // below is harmless (a dependency gate only needs every listed ID
        // completed), but dropping a real cross-story dependency is not.
        for (const _parentDep of Array.isArray(story.dependencies) ? story.dependencies : []) {
          if (!newStory.dependencies.includes(_parentDep)) newStory.dependencies.push(_parentDep);
        }
        // Root cause of "no split has ever succeeded" (found live, 2026-07-06):
        // newStory starts as a full clone of the PARENT (including its combined
        // technicalNotes.files) and this field was never overwritten with the
        // split proposal's own file ownership — every child silently inherited
        // ALL of the parent's files regardless of what was actually proposed,
        // guaranteeing every split looked incoherent (every child "wrote" every
        // file) and was rejected below, no matter how the model partitioned it.
        if (split.technicalNotes && typeof split.technicalNotes === 'object') {
          newStory.technicalNotes = split.technicalNotes;
        }
        // Same backfill as newStory.dependencies above, for the ALTERNATE
        // dependency field this project (and claude.sh's own dependency
        // lookups: `.dependencies // .technicalNotes.dependsOn // []`,
        // consistently a fallback UNION of both fields) actually uses.
        // Found while auditing for other instances of the exact dependency-
        // drop bug (2026-07-12): SKY-002 itself declares its OWN dependency
        // on SKY-001 ONLY via technicalNotes.dependsOn, not .dependencies --
        // so a split of SKY-002 would have been just as vulnerable as
        // SKY-003 was, through this second field path. The technicalNotes
        // reassignment right above can replace the whole object wholesale
        // (e.g. a split proposal supplying only `files`), silently dropping
        // dependsOn the same way the bare dependencies array was dropped --
        // so this backfill must run AFTER that reassignment, not before.
        const _parentDependsOn = Array.isArray(story.technicalNotes?.dependsOn) ? story.technicalNotes.dependsOn : [];
        if (_parentDependsOn.length) {
          if (!newStory.technicalNotes || typeof newStory.technicalNotes !== 'object') newStory.technicalNotes = {};
          const _existingDependsOn = Array.isArray(newStory.technicalNotes.dependsOn) ? newStory.technicalNotes.dependsOn : [];
          const _mergedDependsOn = [..._existingDependsOn];
          for (const _pd of _parentDependsOn) {
            if (!_mergedDependsOn.includes(_pd)) _mergedDependsOn.push(_pd);
          }
          newStory.technicalNotes.dependsOn = _mergedDependsOn;
        }
        newStory.specification = {
          createdFrom: story.id,
          createdAt: new Date().toISOString(),
          runId,
          splitDepth: currentDepth + 1,
          splitOrigin: 'spec-pass'  // marks spec-pass splits; mid-execution splits use 'mid-execution'
        };
        capSplitACs(newStory, story.id);
        correctSplitChildAgentRoleIfTestOnly(prd, newStory);
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
          if (logDir) appendSpecPassEvent(logDir, { storyId: story.id, phase: phaseId, event: 'coherence_violation', decision: 'rejected', details: { file: path.basename(file), childIds } });
        }
        // Roll back all children added during this forEach
        newStories.splice(newStories.length - addedChildren.length, addedChildren.length);
        result.splitCount = 0;
      } else if (addedChildren.length > 0) {
        // Parent AC redistribution — clear parent ACs after split to prevent 93-AC parent stories.
        const childIds = addedChildren.map(ns => ns.story.id).join(', ');
        story.acceptanceCriteria = [`Delegated to split children: ${childIds}`];
        console.log(`spec-mode: parent ${story.id} ACs redistributed → delegated to ${childIds}`);
        if (logDir) appendSpecPassEvent(logDir, { storyId: story.id, phase: phaseId, event: 'story_delegated', decision: 'delegated', details: { childIds: addedChildren.map(ns => ns.story.id) } });
        // Root cause of a real bug (found live, 2026-07-06, tier3-full-run-15):
        // a delegated parent's technicalNotes.files still lists its ORIGINAL
        // files (including any .test.ts), and it stayed in
        // implementationOrder[phase] alongside its own children — every
        // downstream consumer that scans implementationOrder (the TC writer,
        // the main implementation loop) still saw it as an active "test
        // story" with real source, when its actual implementation is now
        // entirely delegated. Mark it deprecated/completed so consumers that
        // already check those fields skip it; implementationOrder itself is
        // cleaned up separately (see the Step 3 insertion loop and
        // validateMidExecutionSplits, which both know the split-vs-parent
        // topology needed to do that safely).
        story.status = 'deprecated';
        story.completed = true;
      }
    }
  }
  return result;
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function appendSpecPassEvent(logDir, { storyId, phase, event, decision, details = {} }) {
  const ts = new Date().toISOString();
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  appendJsonl(path.join(logDir, 'agent-activity.jsonl'), {
    event_id: id,
    timestamp: ts,
    agent: 'spec-coordinator-agent',
    story_id: storyId ?? null,
    phase: phase ?? null,
    type: 'spec_pass_decision',
    detail: { event, decision, ...details },
  });
}

// _promptVersionCache — the epam-cli repo's own short git SHA, computed once
// per process. These prompts live embedded in the scripts themselves (no
// separate template files), so the commit hash of the script IS the version
// proxy for correlating a violation-rate change to "what changed in this
// commit" — mirrors _epam_prompt_version() in run-agent-orchestration.sh.
let _promptVersionCache = null;
function promptVersion() {
  if (_promptVersionCache === null) {
    try {
      _promptVersionCache = execSync('git rev-parse --short HEAD', {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
      }).trim();
    } catch {
      _promptVersionCache = 'unknown';
    }
  }
  return _promptVersionCache;
}

// logGuardedStepRetry — double-write a guarded-step-retry record: unchanged
// per-run file (logDir, wiped on next run's teardown) plus a persistent
// engine-side history file (orchestrations/logs/, survives target-project
// teardown) — same double-write convention as _log_guarded_step_retry() in
// run-agent-orchestration.sh, so bash- and JS-side guarded steps land in the
// same cross-run history for trend/versioning aggregation.
function logGuardedStepRetry(logDir, record) {
  const augmented = { ...record, runId: record.runId ?? 'unknown', promptVersion: promptVersion() };
  appendJsonl(path.join(logDir, 'guarded-step-retries.jsonl'), augmented);
  try {
    const historyDir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(historyDir, { recursive: true });
    appendJsonl(path.join(historyDir, 'guarded-step-retries-history.jsonl'), augmented);
  } catch {
    // Persistent history is best-effort — never let it block the pipeline.
  }
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

const RUNCLAUDE_TIMEOUT_MS = parseInt(process.env.RUNCLAUDE_TIMEOUT_MS || '360000', 10);

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

// buildKnownValidModels <upgradeModel, miniModel>
// isValidModelString <model, currentModel, knownValidModels>
//
// Root cause of a live-run defect (2026-07-02 tier3 core phase): the LLM
// model-review pass's finalModel string was assigned to story.model with
// ZERO validation. The reviewer hallucinated "moonshotai/MiniMax-M3" —
// mixing the moonshotai org prefix with the minimax model name, a string
// that matches no real model on any provider — and every subsequent API
// call for that story failed instantly (cost=$0, 0 tokens), burning all 8
// retry attempts on a broken model string the InferenceLadder could never
// fix (escalation only helps when the *current* model works well enough to
// diagnose a real failure — it can't recover from a malformed model string).
//
// Extracted as standalone functions (not inlined in run()) so this
// validation is directly unit-testable, not just greppable — the whole
// point is to catch this bug CLASS (any future unvalidated LLM-written
// PRD field), not just this one instance.
function buildKnownValidModels(upgradeModel, miniModel) {
  return new Set([
    'MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M2.7', 'MiniMax-M2.1', 'MiniMax-M2',
    'moonshotai/kimi-k2', 'z-ai/glm-5.2', 'z-ai/glm-5.1', 'z-ai/glm-4.7',
    upgradeModel, miniModel,
  ]);
}

// Anthropic/Claude models are never permitted as a story-agent assignment in
// this pipeline (this engine IS Claude Code — running Claude AS a story
// agent inside its own orchestration is not a supported configuration; the
// pipeline is qwen/minimax-routed by design). This is an absolute rule, not
// just a preference for what the default should be — checked independently
// of currentModel/knownValidModels so it still holds even if a story's
// current model was somehow already corrupted to an Anthropic model by an
// earlier bug (defense in depth, not just "fix the default").
const DISALLOWED_MODEL_PATTERN = /^anthropic\/|claude/i;

function isValidModelString(model, currentModel, knownValidModels) {
  if (typeof model !== 'string') return false;
  if (DISALLOWED_MODEL_PATTERN.test(model)) return false;
  return model === currentModel || knownValidModels.has(model);
}

// buildGateExec <aiRunnerCmd>
// The gate model (ORCH_GATE_PROVIDER/ORCH_GATE_MODEL) is independent of the
// story-agent provider resolved by resolvePromptExec — reviewer calls always
// use the gate model, defaulting to minimax/MiniMax-M3 like claude.sh's
// run_prd_change_reviewer.
function buildGateExec(aiRunnerCmd, env = process.env) {
  const provider = env.ORCH_GATE_PROVIDER || 'minimax';
  const model = env.ORCH_GATE_MODEL || 'MiniMax-M3';
  return { cmd: aiRunnerCmd, args: ['--provider', provider, '--model', model] };
}

// parseReviewVerdict <text>
// Extracts {"verdict":"pass|fail",...} from raw LLM output. Mirrors the
// python parsing in claude.sh's run_prd_change_reviewer: try strict JSON
// parse first, fall back to a regex scan for the verdict field.
function parseReviewVerdict(text) {
  const raw = (text || '').trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && (obj.verdict === 'pass' || obj.verdict === 'fail')) {
      return { verdict: obj.verdict, issues: obj.issues || [] };
    }
  } catch { /* fall through to regex */ }
  const m = raw.match(/"verdict"\s*:\s*"(pass|fail)"/);
  return { verdict: m ? m[1] : 'pass', issues: [] };
}

// reviewPrdChange <opts>
// Calls the prd-change-reviewer gate agent to validate a proposed spec-pass
// change (AC/description/title rewrite or split creation) before it is
// accepted. Non-blocking by design: any call failure or unconfigured gate
// defaults to "pass" (matches claude.sh's run_prd_change_reviewer contract) —
// this is a quality gate, not a hard dependency for the spec pass to function.
async function reviewPrdChange({ aiRunnerCmd, profiles, storyId, changeType, before, after, logDir, splitOccurred }) {
  const gateProvider = process.env.ORCH_GATE_PROVIDER || '';
  if (!gateProvider) return { verdict: 'pass', issues: [] };

  const reviewerProfile = profiles['prd-change-reviewer'] || '';
  if (!reviewerProfile) return { verdict: 'pass', issues: [] };

  // When a split occurred alongside other field changes (description/title),
  // the parent's acceptanceCriteria is a deterministic engine-written
  // placeholder ("Delegated to split children: ..."), not organically
  // authored content — tell the reviewer explicitly so it doesn't flag that
  // placeholder as a vague/unmeasurable AC (see isSplitDelegationOnlyChange
  // for the more common case where this skips the reviewer call entirely).
  const splitNote = splitOccurred
    ? '\nNOTE: This story was just split into child stories. Its acceptanceCriteria field is a deterministic "Delegated to split children: ..." placeholder written by the engine, not an authored AC — do NOT flag that placeholder as vague or unmeasurable. Only evaluate the description/title changes.\n'
    : '';

  const prompt = `${reviewerProfile}

STORY: ${storyId}
CHANGE TYPE: ${changeType}
${splitNote}
BEFORE:
${JSON.stringify(before).slice(0, 1000)}

AFTER:
${JSON.stringify(after).slice(0, 1000)}

Emit ONLY: {"verdict":"pass|fail","issues":["<issue1>"],"reason":"<15 words max>"}`;

  try {
    const gateExec = buildGateExec(aiRunnerCmd);
    const logPath = logDir ? path.join(logDir, `prd-reviewer-${storyId}-${changeType}.log`) : null;
    const output = await runClaude(gateExec, prompt, logPath, {});
    return parseReviewVerdict(output);
  } catch (err) {
    console.warn(`spec-mode: prd-change-reviewer call failed for ${storyId} (${err.message}) — defaulting to pass`);
    return { verdict: 'pass', issues: [] };
  }
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

// VERY_HIGH_AC_THRESHOLD (2026-07-15): a story this far past the normal
// upgrade signals (acCount > 15) isn't just "needs a stronger model" — it's
// extreme enough that climbing the retry ladder rung-by-rung (mini -> mid ->
// high, 2 attempts each) burns several guaranteed-failing attempts before
// ever reaching a model with a real chance. Root cause this addresses
// (found live, 2026-07-14, tier3-travel-app run): SKY-003-test (a test
// story assessed via the equivalent TC-fact-density signal, not this
// AC-count one, but the same underlying problem) failed 8/8 attempts across
// every rung, producing widespread syntax corruption at every tier below
// the ceiling. Configurable via VERY_HIGH_AC_THRESHOLD; default picked
// meaningfully above the existing acCount>15 upgrade trigger so this is a
// distinct, rarer classification, not a redundant re-trigger of it.
const VERY_HIGH_AC_THRESHOLD = parseInt(process.env.EPAM_VERY_HIGH_AC_THRESHOLD || '20', 10);

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

  // veryHighComplexity: a SEPARATE, stricter classification (only true for
  // the most extreme cases) — see VERY_HIGH_AC_THRESHOLD's docstring above.
  // Independent of needsUpgrade so it can be checked even when the normal
  // upgrade rules didn't fire (e.g. multi-file stories the isSingleFile
  // gate above would otherwise miss).
  let veryHighComplexity = false;
  let veryHighReason = '';
  if (acCount > VERY_HIGH_AC_THRESHOLD) {
    veryHighComplexity = true;
    veryHighReason = `${acCount} acceptance criteria (> ${VERY_HIGH_AC_THRESHOLD}) — extreme complexity, assign ceiling model directly instead of climbing the retry ladder`;
  }

  return {
    acCount, isSingleFile, hasHtmlOutput, hasSelfContainedKeyword, needsUpgrade, reason,
    veryHighComplexity, veryHighReason,
  };
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
  const _initialStoryIds = new Set((prd.stories || []).map((s) => s.id));
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

  // Root cause this fixes (found live, 2026-07-06, tier3-full-run-16): a
  // rejected split child (depth guard, budget guard, or coherence violation)
  // gets marked status='deprecated' below, but was never removed from
  // implementationOrder[phase] — it was already inserted there by whatever
  // created the mid-execution split BEFORE this validation ran, unlike
  // applySpecChanges' spec-pass path (where rejected children are spliced out
  // of the pending-insert list entirely and never reach implementationOrder
  // in the first place). Violates the same "no deprecated story in
  // implementationOrder" invariant the parent-delegation fix maintains.
  function removeFromImplementationOrder(storyId) {
    const order = prd.implementationOrder?.[phase];
    if (Array.isArray(order)) {
      prd.implementationOrder[phase] = order.filter((id) => id !== storyId);
    }
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
        removeFromImplementationOrder(child.id);
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
        removeFromImplementationOrder(r.id);
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
        appendSpecPassEvent(logDir, { storyId: parentId, phase, event: 'coherence_violation', decision: 'rejected', details: { file: path.basename(file), childIds, source: 'mid_execution' } });
      }
      for (const child of children) {
        child.specification.splitRejected = true;
        child.specification.splitRejectionReason = `same-file coherence violation: multiple children write to the same file`;
        child.status = 'deprecated';
        removeFromImplementationOrder(child.id);
      }
      hardViolations++;

      // Root cause this fixes (found live, 2026-07-10, tier3-travel-app run):
      // openspec (elaboration) and speckit (verification) each independently
      // split SKY-002 without knowing about each other, producing TWO
      // redundant impl/test pairs that collide on client.ts/client.test.ts.
      // Both pairs got deprecated here — correctly — but parentStory.status
      // was ALREADY 'deprecated' (set by applySpecChanges' spec-pass path
      // when the FIRST of the two redundant splits looked valid in
      // isolation), and nothing here ever restored it. Result: the
      // Skyscanner API client was never implemented at all this run — every
      // downstream story that depended on it (SKY-003, SKY-004) failed on a
      // missing module. If the parent has no OTHER surviving (non-deprecated,
      // non-rejected) children from a different split attempt, it must be
      // resurrected as a single unsplit story — otherwise its entire scope
      // silently vanishes with no story left to implement it.
      const parentHasSurvivingChildren = prd.stories.some(
        (s) => s.specification?.createdFrom === parentId
          && s.status !== 'deprecated'
          && !s.specification?.splitRejected
      );
      if (!parentHasSurvivingChildren && parentStory.status === 'deprecated') {
        const restoredACs = [...new Set(children.flatMap((c) => c.acceptanceCriteria || []))];
        parentStory.status = 'pending';
        parentStory.completed = false;
        if (restoredACs.length) {
          parentStory.acceptanceCriteria = restoredACs;
        }
        const orderForRestore = prd.implementationOrder?.[phase];
        if (Array.isArray(orderForRestore) && !orderForRestore.includes(parentId)) {
          orderForRestore.push(parentId);
        }
        console.warn(
          `spec-mode: --validate-splits: ${parentId} has no surviving split children — ` +
          `restoring as a single unsplit story so its scope isn't lost`
        );
        appendSpecPassEvent(logDir, { storyId: parentId, phase, event: 'story_restored', decision: 'restored', details: {} });
      }
      continue;
    }

    // AC cap on each child
    for (const child of children) capSplitACs(child, parentId);
    for (const child of children) correctSplitChildAgentRoleIfTestOnly(prd, child);

    // Wire test-child dependencies onto impl siblings from the SAME split —
    // see wireSplitSiblingDependencies' docstring for the live defect this
    // fixes. Must run after the coherence check above so a rejected sibling
    // (already spliced out / deprecated) is never wired.
    wireSplitSiblingDependencies(children, prd);
    reorderSiblingsByDependency(children, prd.implementationOrder?.[phase]);

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

    let speckitResult = null;
    try {
      speckitResult = await runSpeckitReview({
        promptExec,
        story: parentStory,
        openspecOutput,
        phase,
        runId,
        logDir
      });
    } catch (err) { speckitResult = null; }

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

    // Mark children validated and tag as mid-execution so pre-flight can strip them on next restore
    for (const child of children) {
      child.specification.speckitValidated = true;
      child.specification.speckitValidatedAt = new Date().toISOString();
      child.specification.splitOrigin = 'mid-execution';
    }

    // Parent AC redistribution
    const childIds = children.map(c => c.id).join(', ');
    parentStory.acceptanceCriteria = [`Delegated to split children: ${childIds}`];
    console.log(`spec-mode: --validate-splits: ${parentId} → validated ${children.length} children (${childIds})`);
    // Same fix as applySpecChanges' spec-pass split path (found live,
    // 2026-07-06, tier3-full-run-15): a validated parent's technicalNotes.
    // files still lists its original (now-delegated) files, and it stayed in
    // implementationOrder[phase] alongside its own children — the TC writer
    // and main implementation loop both scan implementationOrder and saw it
    // as active work with real source, when it's now entirely delegated.
    parentStory.status = 'deprecated';
    parentStory.completed = true;
    const order = prd.implementationOrder?.[phase];
    if (Array.isArray(order)) {
      prd.implementationOrder[phase] = order.filter((id) => id !== parentId);
    }
  }

  // Story-ID-loss invariant — see assertNoStoryIdsLost's docstring.
  assertNoStoryIdsLost(_initialStoryIds, new Set((prd.stories || []).map((s) => s.id)), 'validateMidExecutionSplits()');

  // Atomic write, lock-protected — see the identical rationale at run()'s
  // writeFileSync call.
  const _prdLockPath2 = `${prdFile}.lock`;
  acquireFileLock(_prdLockPath2);
  try {
    const _tmpPrdFile = `${prdFile}.tmp`;
    fs.writeFileSync(_tmpPrdFile, JSON.stringify(prd, null, 2) + '\n');
    fs.renameSync(_tmpPrdFile, prdFile);
  } finally {
    releaseFileLock(_prdLockPath2);
  }

  if (hardViolations > 0) {
    console.error(`spec-mode: --validate-splits: ${hardViolations} hard violation(s) — check PRD for deprecated splits`);
    process.exit(1);
  }

  console.log('spec-mode: --validate-splits: complete');
}

// splitTestStoryCli <prdFile> <storyId> — shell entry point for
// lib/tc-writer-gate.sh's TC-fact-density split mandate. Loads the PRD,
// locates the story's phase (whichever implementationOrder[phase] array
// contains it), delegates to splitTestStoryByFacts(), and writes the PRD
// back atomically (same lock pattern as validateMidExecutionSplits above).
// Exits 0 with splitCount>0 printed to stdout on success, exits 1 if the
// story wasn't found or wasn't eligible to split (so the caller can treat
// that as "nothing to do" rather than a real error).
function splitTestStoryCli(prdFile, storyId) {
  if (!prdFile || !storyId) {
    console.error('spec-mode: --split-test-story: usage: --split-test-story <prdFile> <storyId>');
    process.exit(1);
  }
  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  const _initialStoryIds = new Set((prd.stories || []).map((s) => s.id));
  const story = prd.stories.find((s) => s.id === storyId);
  if (!story) {
    console.error(`spec-mode: --split-test-story: story ${storyId} not found`);
    process.exit(1);
  }
  const phase = Object.keys(prd.implementationOrder || {})
    .find((p) => (prd.implementationOrder[p] || []).includes(storyId)) || process.env.PHASE || 'unknown';

  const maxFactsPerChild = parseInt(process.env.EPAM_TC_FACTS_SPLIT_THRESHOLD || String(TC_FACTS_SPLIT_THRESHOLD), 10);
  const { splitCount, childIds } = splitTestStoryByFacts(story, prd, phase, maxFactsPerChild);
  if (splitCount === 0) {
    console.log(`spec-mode: --split-test-story: ${storyId} not eligible to split (not a pure single-test-file story, or facts <= threshold)`);
    process.exit(1);
  }

  assertNoStoryIdsLost(_initialStoryIds, new Set((prd.stories || []).map((s) => s.id)), 'splitTestStoryCli()');

  const _prdLockPath = `${prdFile}.lock`;
  acquireFileLock(_prdLockPath);
  try {
    const _tmpPrdFile = `${prdFile}.tmp`;
    fs.writeFileSync(_tmpPrdFile, JSON.stringify(prd, null, 2) + '\n');
    fs.renameSync(_tmpPrdFile, prdFile);
  } finally {
    releaseFileLock(_prdLockPath);
  }

  console.log(`spec-mode: --split-test-story: ${storyId} → ${childIds.join(', ')} (splitCount=${splitCount})`);
}

if (require.main === module) {
  if (process.argv[2] === '--validate-splits') {
    validateMidExecutionSplits(process.argv[3], process.argv[4]).catch((err) => {
      console.error('spec-mode-runner --validate-splits failed:', err);
      process.exit(1);
    });
  } else if (process.argv[2] === '--split-test-story') {
    try {
      splitTestStoryCli(process.argv[3], process.argv[4]);
    } catch (err) {
      console.error('spec-mode-runner --split-test-story failed:', err);
      process.exit(1);
    }
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
  storyRequiresSplit,
  checkSplitMandateViolation,
  isSplitDelegationAc,
  correctSplitChildAgentRoleIfTestOnly,
  wireSplitSiblingDependencies,
  reorderSiblingsByDependency,
  assertNoStoryIdsLost,
  resolveModelProvider,
  isSplitDelegationOnlyChange,
  SPLIT_MANDATE_AC_THRESHOLD,
  applySpecChanges,
  validateMidExecutionSplits,
  extractCodeRefs,
  resolvePromptProvider,
  resolvePromptExec,
  buildGateExec,
  parseReviewVerdict,
  reviewPrdChange,
  buildKnownValidModels,
  isValidModelString,
  isMiniTierModel,
  modelComplexitySignals,
  MAX_ACS_PER_STORY,
  MAX_CHILDREN_PER_SPLIT,
  promptVersion,
  logGuardedStepRetry,
  checkTcFactDensityMandate,
  splitTestStoryByFacts,
  TC_FACTS_SPLIT_THRESHOLD,
  VERY_HIGH_AC_THRESHOLD,
};
