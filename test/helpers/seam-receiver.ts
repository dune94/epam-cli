/**
 * EVERY SEAM, THROUGH THE REAL STACK, FOR £0.
 *
 * The pipeline reaches a model through one funnel: a caller invokes claude.sh or ai-run.sh, both of
 * which end at llm-handler.sh, which execs the runner binary named by $CLAUDE_CMD. A stub placed at
 * CLAUDE_CMD leaves EVERY layer above it — seam resolution, ladder selection, flag construction,
 * the hub's own dispatch — executing for real, which is what a receiver test has to do.
 *
 * Stubbing any higher would skip the layer that failed: discovery emitted `--provider --model X`
 * and llm-handler read '--model' as the provider's value. Only a stub BELOW the hub sees that.
 *
 * The stub records the argument vector it was given and the prompt it received on stdin, because
 * those two artefacts are what the layers above actually produce.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(__dirname, '../..');
export const SCRIPTS = join(REPO, 'orchestrations/scripts');

/** Every seam the registry declares — discovered, never listed. */
export function declaredSeams(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const reg = require(join(REPO, 'orchestrations/agents/invocation-profiles.json'));
  return Object.keys(reg.seams || reg.profiles || reg);
}

/** The registry entry for a seam. */
export function seamProfile(seam: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const reg = require(join(REPO, 'orchestrations/agents/invocation-profiles.json'));
  return (reg.seams || reg.profiles || reg)[seam];
}

export interface HubResult {
  code: number; stdout: string; stderr: string;
  /** Argument vectors the runner binary was invoked with, one array per call. */
  runnerArgv: string[][];
  /** Prompts the runner received on stdin, one per call. */
  prompts: string[];
  workDir: string;
}

/** The ladder environment a run exports, read from the set rather than invented. */
function ladderEnv(): Record<string, string> {
  const dump = `${JSON.stringify(process.execPath)} -e `
    + `'for (const [k,v] of Object.entries(process.env)) `
    + `if (k.startsWith("EPAM_MODEL_LADDER")) process.stdout.write(k+"="+v+"\\n")'`;
  const r = spawnSync('bash', ['-c', `
    cd ${JSON.stringify(REPO)}
    . orchestrations/scripts/lib/model-ladders.sh
    export_model_ladders orchestrations/config/llm-defaults.claude.json >/dev/null 2>&1
    ${dump}
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, EPAM_PROVIDER_SET: 'claude' } });
  const out: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
const LADDERS = ladderEnv();

export interface HubOptions {
  /** What the stubbed runner answers. */
  reply?: string;
  /** Runner exits non-zero, as a failing binary does. */
  exitCode?: number;
  /** Extra environment for the whole stack. */
  env?: Record<string, string>;
  /** Shared coverage directory, so many calls accumulate into one figure. */
  covDir?: string;
}

/**
 * Call the hub for one seam exactly as a caller does: prompt on stdin, seam environment resolved by
 * the pipeline's own seam-invocation, runner stubbed at the bottom.
 *
 * ARGUMENTS ARE RECORDED ONE PER LINE with a sentinel between calls. An empty argument still
 * occupies a line, so a value that vanished is visible as a MISSING line rather than an empty
 * string — which is the whole defect being guarded.
 */
export function callSeamThroughHub(seam: string, prompt: string, o: HubOptions = {}): HubResult {
  const work = mkdtempSync(join(tmpdir(), `seam-${seam.replace(/[^a-z0-9]/gi, '-')}-`));
  const argvLog = join(work, 'argv.log');
  const promptDir = join(work, 'prompts');
  mkdirSync(promptDir, { recursive: true });

  const runner = join(work, 'stub-runner');
  writeFileSync(runner, [
    '#!/usr/bin/env bash',
    '# The runner binary the hub execs. Records what it was given, then answers.',
    `printf -- '--CALL--\\n' >> ${JSON.stringify(argvLog)}`,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done`,
    `n=$(ls ${JSON.stringify(promptDir)} | wc -l)`,
    `cat > ${JSON.stringify(promptDir)}/"$n"`,
    `printf '%s' ${JSON.stringify(o.reply ?? '{"ok":true}')}`,
    `exit ${o.exitCode ?? 0}`,
    '',
  ].join('\n'));
  chmodSync(runner, 0o755);

  const covDir = o.covDir ?? join(work, 'cov');
  mkdirSync(covDir, { recursive: true });

  const r = spawnSync('bash', [join(SCRIPTS, 'llm-handler.sh'), '--provider', 'claude'], {
    encoding: 'utf8', input: prompt, timeout: 120000, cwd: REPO,
    env: {
      ...process.env, ...LADDERS,
      EPAM_PROVIDER_SET: 'claude',
      EPAM_AGENT_NAME: seam,
      CLAUDE_CMD: runner,
      LOG_DIR: work,
      NODE_V8_COVERAGE: covDir,
      ...(o.env ?? {}),
    },
  });

  const runnerArgv: string[][] = [];
  if (existsSync(argvLog)) {
    for (const line of readFileSync(argvLog, 'utf8').split('\n')) {
      if (line === '--CALL--') { runnerArgv.push([]); continue; }
      if (runnerArgv.length) runnerArgv[runnerArgv.length - 1].push(line);
    }
    // The trailing newline of the last argument is not an argument.
    for (const v of runnerArgv) if (v.length && v[v.length - 1] === '') v.pop();
  }
  const prompts = existsSync(promptDir)
    ? readdirSync(promptDir).map((f) => readFileSync(join(promptDir, f), 'utf8'))
    : [];

  return {
    code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    runnerArgv, prompts, workDir: work,
  };
}
