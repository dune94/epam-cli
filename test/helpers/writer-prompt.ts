/**
 * RENDER THE REAL WRITER PROMPT, EXACTLY AS THE PIPELINE BUILDS IT.
 *
 * WHY THIS EXISTS
 *
 * The writer prompt is about to be taken apart: twenty-five blocks of prose move out of the shell
 * into a prompt document, and eleven agent outputs stop being hand-rendered by the consumer and
 * start arriving through the published-inputs channel. The risk in that work is not that it fails
 * loudly — it is that a section quietly stops being emitted and nobody notices until a writer runs
 * for three hours without the one instruction it needed. That has already happened here.
 *
 * So: capture the bytes first. Every migration step re-renders the same fixtures and diffs against
 * what was captured. A section that disappears shows up as a diff in a test, in seconds, instead
 * of as a bad run.
 *
 * HOW IT AVOIDS BECOMING A SECOND COPY OF THE PROMPT
 *
 * It copies nothing and reassembles nothing. It runs the real claude.sh with one line removed —
 * the final `main "$@"` — so every function definition and all 109 lines of top-level setup are
 * the file's own. The prelude was checked and only declares variables and sources libraries; it
 * writes nothing, so running it is inert. Then LOG_DIR and friends are repointed at a scratch
 * directory and the real build_implementation_prompt is called.
 *
 * When the prompt builder changes, this harness renders the change. That is the entire point, and
 * it is why there is no list of helper functions here to fall out of step.
 *
 * WHAT IS STUBBED, AND WHY THAT IS SAFE
 *
 * Only `log`, which claude.sh writes to stderr — progress text, never prompt text. jq, node and
 * python3 run for real, and so do lib/prompt-library.js, lib/render-prompt-section.js,
 * lib/vc-coverage-findings.js and brownfield-coverage-gate.sh. The blocks those render are exactly
 * the blocks the migration is about to move, so stubbing them would blind the harness to the one
 * thing it is here to watch.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const CLAUDE_SH = join(SCRIPTS, 'claude.sh');
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

/**
 * claude.sh with its entry point removed: definitions and setup, no run.
 *
 * `main "$@"` is the last executable line of the file. Removing it and nothing else keeps the
 * harness honest — there is no second, drifting copy of the setup that production performs.
 */
export function claudeShAsLibrary(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const lines = src.split('\n');
  const idx = lines.map((l) => l.trim()).lastIndexOf('main "$@"');
  if (idx === -1) {
    throw new Error('claude.sh no longer ends by calling main "$@" — the harness would either run '
      + 'a whole orchestration or render nothing, and both look like a passing test');
  }
  lines[idx] = ': # entry point removed by the writer-prompt harness';
  return lines.join('\n');
}

export interface WriterPromptFixture {
  /** The PRD story, verbatim. Its shape is the pipeline's, not the harness's. */
  story: Record<string, unknown>;
  /** Written to LOG_DIR/review-feedback-<id>.json — where the reviewer's output lands today. */
  reviewFeedback?: unknown;
  /** Written to LOG_DIR/vc-coverage-<id>.json — where the coverage check's output lands today. */
  vcCoverage?: unknown;
  /** Files created under PROJECT_ROOT before rendering: relative path → contents. */
  projectFiles?: Record<string, string>;
  /** Environment for the render: EPAM_BROWNFIELD, WORKTREE_MODE, CROSS_CODELINE_CONTRACT… */
  env?: Record<string, string>;
  /** agent-profiles.json contents, for the persisted-skill-note block. */
  profiles?: unknown;
}

export interface RenderedPrompt {
  /** The prompt, byte for byte, as build_implementation_prompt emitted it. */
  text: string;
  /** Non-zero means the builder REFUSED to build — itself a fact worth pinning. */
  rc: number;
  /** stderr, kept out of the captured bytes but available when a render surprises you. */
  stderr: string;
  /** Absolute path of the scratch PROJECT_ROOT, for assertions about injected file contents. */
  projectRoot: string;
}

const dirs: string[] = [];
/** Remove every scratch directory this harness made. Call from afterAll. */
export function cleanupWriterPromptFixtures(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function renderWriterPrompt(fx: WriterPromptFixture): RenderedPrompt {
  const dir = mkdtempSync(join(tmpdir(), 'writer-prompt-'));
  dirs.push(dir);
  const projectRoot = join(dir, 'project');
  const logDir = join(dir, 'logs');
  mkdirSync(join(projectRoot, '.epam'), { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const storyId = String(fx.story.id ?? 'S-1');
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [fx.story] }, null, 2));

  const profiles = join(dir, 'agent-profiles.json');
  writeFileSync(profiles, JSON.stringify(fx.profiles ?? { profiles: {} }, null, 2));

  if (fx.reviewFeedback !== undefined) {
    writeFileSync(join(logDir, `review-feedback-${storyId}.json`), JSON.stringify(fx.reviewFeedback, null, 2));
  }
  if (fx.vcCoverage !== undefined) {
    writeFileSync(join(logDir, `vc-coverage-${storyId}.json`), JSON.stringify(fx.vcCoverage, null, 2));
  }
  // A project-authority prompt directory, minted the way a fresh project's would be: every
  // template copied in, none named here. The pipeline refuses to run a template directly and
  // refuses to build a writer prompt when a policy fails to render, so without this the harness
  // would capture rc=1 and nothing else — which is a real behaviour, but not the one being pinned.
  const projectConfig = join(dir, 'project-config');
  const promptDir = join(projectConfig, 'prompts');
  mkdirSync(promptDir, { recursive: true });
  const templateDir = join(ROOT, 'orchestrations/prompts/templates');
  for (const t of readdirSync(templateDir)) {
    if (t.endsWith('.json')) writeFileSync(join(promptDir, t), readFileSync(join(templateDir, t)));
  }

  // PUBLISH WHAT THE PRODUCERS PRODUCED, as the orchestrator does after the spec pass. Without
  // this the writer's declared inputs are simply absent, which is a real behaviour but not the one
  // being captured — and it would make every "nothing was lost" assertion pass on an empty prompt.
  const agentIoDir = join(logDir, 'agent-io');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { publishFixPlans } = require(join(SCRIPTS, 'lib/producers/fix-plan.js'));
  publishFixPlans({ stories: [fx.story] }, { AGENT_IO_DIR: agentIoDir });

  for (const [rel, contents] of Object.entries(fx.projectFiles ?? {})) {
    const abs = join(projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  // The real file, then the redirection onto scratch state, then one call. LOG_DIR and PROGRESS_LOG
  // are reassigned AFTER the prelude because claude.sh sets them unconditionally from its own
  // location — left alone, a render would read the repository's live logs.
  const script = `${claudeShAsLibrary()}

# ---- writer-prompt harness ----
set +e
PROJECT_ROOT=${JSON.stringify(projectRoot)}
PRD_FILE=${JSON.stringify(prd)}
LOG_DIR=${JSON.stringify(logDir)}
AGENT_PROFILES_FILE=${JSON.stringify(profiles)}
PROGRESS_LOG="$LOG_DIR/progress.txt"
CLAUDE_OUTPUT_DIR="$LOG_DIR/claude_outputs"
MONITOR_STATUS_FILE="$LOG_DIR/agent-status.json"
NODE_BIN=${JSON.stringify(NODE_BIN)}
export PROJECT_ROOT PRD_FILE LOG_DIR AGENT_PROFILES_FILE NODE_BIN

log() { printf '%s\\n' "$*" >&2; }

build_implementation_prompt ${JSON.stringify(storyId)}
`;

  // The script must live in the REAL scripts directory: claude.sh derives SCRIPT_DIR from its own
  // BASH_SOURCE and resolves lib/, ../config/ and ../agents/ from it. Run from a scratch directory
  // it cannot find its own libraries. It is removed in the finally below, whatever happens.
  const scriptPath = join(SCRIPTS, `.writer-prompt-harness-${process.pid}-${dirs.length}.sh`);
  writeFileSync(scriptPath, script);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(NODE_BIN)}:${process.env.PATH}`,
    PROJECT_ROOT: projectRoot,
    PRD_FILE: prd,
    AGENT_PROFILES_FILE: profiles,
    EPAM_PROJECT_CONFIG_DIR: projectConfig,
    // Named explicitly, exactly as the orchestrator names it: claude.sh reassigns LOG_DIR from its
    // own location, so a store derived from LOG_DIR would be written and read in two places.
    AGENT_IO_DIR: agentIoDir,
    ...(fx.env ?? {}),
  };

  try {
    const text = execFileSync('bash', [scriptPath], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    return { text, rc: 0, stderr: '', projectRoot };
  } catch (e: any) {
    return {
      text: e.stdout ?? '',
      rc: e.status ?? -1,
      stderr: (e.stderr ?? '')
        + (e.status == null ? `\n[harness] bash did not run: ${e.code ?? e.message}` : ''),
      projectRoot,
    };
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

/**
 * Replace the paths that differ between machines and runs with stable markers, so a capture taken
 * today compares to one taken tomorrow. Scratch paths only — never prompt content.
 */
export function stabilise(text: string): string {
  return text
    .replace(/\/tmp\/writer-prompt-[A-Za-z0-9]+/g, '<SCRATCH>')
    .replace(new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<REPO>/');
}
