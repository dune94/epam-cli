/**
 * RUNS DISCOVERY THE WAY THE PIPELINE RUNS IT — as a spawned script, for £0.
 *
 * Every earlier discovery test either called an exported function directly or needed a live model.
 * Neither is the receiver: codeline-discovery.js is a CLI guarded by `if (require.main !== module)`,
 * so requiring it executes none of the code that decides anything. A change to callLlm, to the rung
 * it asks for, or to what it writes is invisible to a test that imports a function.
 *
 * The script already declares the seam this needs — CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE, "lets a
 * test point callLlm() at a fake ai-run.sh stub with a controlled response, without ever touching
 * the real one". This drives it, with a real git estate on disk and the same ladder environment a
 * run exports, and reports what the child itself executed via NODE_V8_COVERAGE.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(__dirname, '../..');
const NODE = process.execPath;

/** The discovery modules a receiver run can reach. codeline-structure.js was deleted for having none. */
export const DISCOVERY_FILES = [
  'codeline-discovery', 'codeline-name', 'codeline-score', 'codeline-facts',
].map((n) => join(REPO, 'orchestrations/scripts/lib', `${n}.js`));

export interface Estate { [dir: string]: { [file: string]: string } }

export interface RunOptions {
  /** Repositories to create, each a real git checkout. */
  estate?: Estate;
  /** Tickets as the tracker hands them over. */
  issues?: unknown[];
  /** What the stubbed model says, in order. A function sees the attempt number, 1-based. */
  reply?: string | ((attempt: number) => string);
  /** Written to ORCH_JSON_RESULT — the normalized result ai-run.sh produces. */
  result?: Record<string, unknown>;
  /** Stub exits non-zero, as a failing runner does. */
  exitCode?: number;
  /** Extra environment, and extra CLI arguments. */
  env?: Record<string, string>;
  args?: string[];
  /** Point --root somewhere else, to exercise an unreadable or absent codeline root. */
  rootOverride?: string;
  /** Estate entries to leave as plain directories — a repository is what `git init` makes it. */
  nonRepos?: string[];
  /** Emit a [provider] notice on stderr, as the real handler does when it reroutes. */
  providerNotice?: boolean;
  /** Told the temp working directory before the stub replies, so a reply can name a real path. */
  onWork?: (work: string) => void;
  /** Omit --issues/--root/--out, to reach the usage path. */
  omitArgs?: boolean;
  /** Where V8 writes the child's own coverage. Shared across runs to accumulate. */
  covDir?: string;
}

export interface RunResult {
  code: number; stdout: string; stderr: string;
  out: any | null; workDir: string; factsWritten: boolean;
  /** Every argument vector the stub was invoked with — one array per attempt. */
  stubArgv: string[][];
}

/** The ladder environment a real run exports, read from the set rather than invented. */
function ladderEnv(): Record<string, string> {
  const r = spawnSync('bash', ['-c', `
    cd ${JSON.stringify(REPO)}
    . orchestrations/scripts/lib/model-ladders.sh
    export_model_ladders orchestrations/config/llm-defaults.claude.json >/dev/null 2>&1
    # READ THE ENVIRONMENT A CHILD ACTUALLY GETS. \`env\` reported none of these while a spawned
    # child inherited seven, so asking a real child is the only answer that matches the receiver.
    ${JSON.stringify(NODE)} -e 'for (const [k,v] of Object.entries(process.env)) if (k.startsWith("EPAM_MODEL_LADDER")) process.stdout.write(k+"="+v+"\\n")'
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, EPAM_PROVIDER_SET: 'claude' } });
  const out: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
const LADDERS = ladderEnv();

/** Every path in the estate, so a test can name one without hardcoding the temp directory. */
export function estatePath(work: string, repo: string) { return join(work, 'estate', repo); }

export function runDiscovery(o: RunOptions = {}): RunResult {
  const work = mkdtempSync(join(tmpdir(), 'discovery-receiver-'));
  if (o.onWork) o.onWork(work);
  const estate = o.estate ?? {
    'alpha.shop.com': { 'src/checkout.js': 'checkout email confirm address' },
    'beta.shop.com': { 'src/schedule.js': 'timetable departures' },
  };

  for (const [dir, files] of Object.entries(estate)) {
    const root = estatePath(work, dir);
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    // A directory is only a candidate once it is a git repository. Leaving one plain is how a test
    // reaches the empty-estate path — initialising every entry made "not-a-repo" into a repo.
    if ((o.nonRepos ?? []).includes(dir)) continue;
    spawnSync('bash', ['-c',
      `cd ${JSON.stringify(root)} && git init -q . && git add -A `
      + `&& git -c user.email=t@t -c user.name=t commit -qm init`], { encoding: 'utf8' });
  }

  const issues = o.issues ?? [{
    key: 'AB-1',
    fields: { summary: 'Checkout email case sensitivity', description: 'confirm email field' },
  }];
  writeFileSync(join(work, 'issues.json'), JSON.stringify(issues));

  // THE STUB IS THE MODEL. It counts its own attempts on disk, so a reply that varies per attempt
  // exercises the retry path rather than a test asserting the retry exists.
  const replyFn = typeof o.reply === 'function' ? o.reply : null;
  const replies = replyFn
    ? [1, 2, 3, 4].map((n) => replyFn(n))
    : [o.reply ?? JSON.stringify({
      codelines: [{
        path: estatePath(work, 'alpha.shop.com'), name: 'model-said-this',
        reason: 'checkout lives here', evidence: 'checkout email confirm',
      }],
    })];
  writeFileSync(join(work, 'replies.json'), JSON.stringify(replies));
  writeFileSync(join(work, 'result.json'), JSON.stringify(o.result ?? { stop_reason: 'end_turn' }));

  // THE STUB IS THE REAL INTERFACE, NOT AN IMPRESSION OF IT.
  //
  // llm-handler.sh — which ai-run.sh is now only a shim for — reads the prompt from stdin, writes
  // the provider's output to stdout, copies its normalized JSON to ORCH_JSON_RESULT, accepts
  // exactly --provider/--model/--help, EXITS 2 on any other option, and sends its [provider]
  // notices to stderr. A stub that shrugged at an unknown option would go green on a broken
  // command line; a stub that printed the notice on stdout would hide the defect that merged a
  // diagnostic into the answer. Both behaviours are reproduced here, and a contract test asserts
  // this stub and the real handler still agree.
  const stub = join(work, 'stub-ai-run.sh');
  writeFileSync(stub, `#!/usr/bin/env bash
# The vector this was called with, recorded before parsing: an empty interpolated value produces
# no argument at all, so the shape of the vector is the evidence.
printf '%s\\n' "$(printf '%s\\u0001' "$@")" >> "${work}/argv.log"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) shift 2 ;;
    --model)    shift 2 ;;
    --help|-h)  echo "Usage: llm-handler.sh [--provider NAME] [--model NAME]"; exit 0 ;;
    *)          echo "llm-handler.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
done
cat > /dev/null
${o.providerNotice ? `printf '%s\\n' "  [provider] 'x' is not routable by the '' set — using 'y'." >&2` : ''}
n=0; [ -f "${work}/attempts" ] && n=$(cat "${work}/attempts")
n=$((n+1)); echo "$n" > "${work}/attempts"
[ -n "\${ORCH_JSON_RESULT:-}" ] && cat "${work}/result.json" > "\$ORCH_JSON_RESULT"
${NODE} -e '
  const r=require("${work}/replies.json");
  process.stdout.write(String(r[Math.min(Number(process.argv[1])-1, r.length-1)] ?? ""));
' "$n"
exit ${o.exitCode ?? 0}
`);
  chmodSync(stub, 0o755);

  const covDir = o.covDir ?? join(work, 'cov');
  mkdirSync(covDir, { recursive: true });

  const args = o.omitArgs ? (o.args ?? []) : [
    '--issues', join(work, 'issues.json'),
    '--root', o.rootOverride ?? join(work, 'estate'),
    '--out', join(work, 'out.json'),
    ...(o.args ?? []),
  ];

  const r = spawnSync(NODE, [join(REPO, 'orchestrations/scripts/lib/codeline-discovery.js'), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: REPO,
    env: {
      ...process.env, ...LADDERS,
      EPAM_PROVIDER_SET: 'claude',
      LOG_DIR: work,
      NODE_V8_COVERAGE: covDir,
      CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub,
      EPAM_PROJECT_CONFIG_DIR: '',
      ...(o.env ?? {}),
    },
  });

  const outPath = join(work, 'out.json');
  const argvLog = join(work, 'argv.log');
  const stubArgv = existsSync(argvLog)
    ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean)
      .map((l) => l.split('\u0001').filter((x) => x !== ''))
    : [];
  return {
    stubArgv,
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null,
    workDir: work,
    factsWritten: existsSync(join(work, 'project', 'generated', 'codeline-facts.json')),
  };
}
