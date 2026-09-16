/**
 * A SEAM'S TOOL GRANT IS BOUND AT THE RUNNER — ON EVERY ARM, NOT JUST `epam run`.
 *
 * Every seam declares a grant kind and it travels as EPAM_ALLOWED_TOOLS + AI_GATE_ALLOW_TOOLS.
 * src/agent/AgentRunner.ts honours it on the `epam run` arm; the one-shot CLI arms (claude,
 * codemie-claude) ran `--print --dangerously-skip-permissions` with the runner's whole tool set,
 * so the grant bound nothing on the stack the operator actually runs. Run 20260916T225207Z
 * (skyscanner, claude set): project-roster-review — declared read-only — ran `find / -iname
 * prd.json`, listed the pipeline's own cassettes directory, read five earlier runs' agent-mint
 * records and refused the roster for disagreeing with them. The 2026-09-12 roster specialiser,
 * declared write-file, spent ~350 shell calls copying a repository into the codeline.
 *
 * This EXECUTES the real llm-handler.sh against a stub runner that advertises the flag in its
 * --help and records the argv it was invoked with — the receiver's side. The expected runner-side
 * names are read from the runner's OWN declaration (toolNames), never spelled here.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Runner = { toolNames?: Record<string, string[]> };
function declaredRunner(set: string, name: string): Runner {
  return JSON.parse(readFileSync(join(ROOT, `orchestrations/config/llm-defaults.${set}.json`), 'utf8')).runners[name];
}

/** A stub CLI: prints --help naming (or not naming) --tools; otherwise records argv and answers. */
function stub(name: string, advertisesTools: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'grant-bind-')); dirs.push(dir);
  const argv = join(dir, 'argv.txt');
  const bin = join(dir, name);
  writeFileSync(bin, [
    '#!/usr/bin/env bash',
    `if [ "\${1:-}" = "--help" ]; then echo "Usage: ${name}"; ${advertisesTools ? 'echo "  --tools <tools...>  Specify the list of available tools"' : ':'}; exit 0; fi`,
    `printf '%s\\n' "$@" > ${JSON.stringify(argv)}`,
    'cat >/dev/null',
    'echo \'{"result":"OK","is_error":false}\'',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return { dir, bin, argv };
}

function callHub(provider: string, s: ReturnType<typeof stub>, env: Record<string, string>, set = 'claude') {
  const r = spawnSync('bash', [HUB, '--provider', provider, '--model', 'a-model'], {
    encoding: 'utf8', input: 'judge this', timeout: 60_000,
    env: {
      ...process.env, PATH: `${s.dir}:${process.env.PATH}`, CLAUDE_CMD: s.bin,
      EPAM_PROVIDER_SET: set, EPAM_PROJECT_CONFIG_DIR: '',
      AI_GATE_ALLOW_TOOLS: '', EPAM_ALLOWED_TOOLS: '', EPAM_RESPONSE_SCHEMA: '', EPAM_STORY_BUDGET_HARD_LIMIT_USD: '',
      ...env,
    },
  });
  const argv = existsSync(s.argv) ? readFileSync(s.argv, 'utf8').split('\n').filter(Boolean) : [];
  const i = argv.indexOf('--tools');
  return { r, argv, tools: i >= 0 ? argv[i + 1] : undefined, stderr: r.stderr };
}

describe("a seam's tool grant is bound at the runner", () => {
  const claude = declaredRunner('claude', 'claude');

  it('the claude runner declares its vocabulary for every tool the read-only floor grants', () => {
    const floor: string[] = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/spec-mode-defaults.json'), 'utf8')).tools.readOnlyBuiltins;
    expect(floor.length).toBeGreaterThan(0);
    for (const t of floor) expect(claude.toolNames?.[t], `runner has no name for pipeline tool ${t}`).toBeTruthy();
  });

  it("RUN 6's SHAPE: a read-only grant reaches the runner as its own read-only tools — and NOT its shell", () => {
    const s = stub('claude', true);
    const grant = 'read_file,list_files,search';
    const { tools, r } = callHub('claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: grant });
    expect(r.status, r.stderr).toBe(0);
    const expected = grant.split(',').flatMap((t) => claude.toolNames![t]);
    expect(tools, 'the grant was not bound at the runner').toBe(expected.join(','));
    for (const shell of claude.toolNames!.bash) expect(tools!.split(',')).not.toContain(shell);
  });

  it('a plugin tool the runner does not declare is dropped, and the drop is said aloud', () => {
    const s = stub('claude', true);
    const { tools, stderr } = callHub('claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,codegraph_query' });
    expect(tools).toBe(claude.toolNames!.read_file.join(','));
    expect(stderr).toMatch(/codegraph_query/);
  });

  it('a write-file grant gives the file tools and still no shell (the 2026-09-12 specialiser)', () => {
    const s = stub('claude', true);
    const { tools } = callHub('claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,list_files,search,write_file' });
    for (const w of claude.toolNames!.write_file) expect(tools!.split(',')).toContain(w);
    for (const shell of claude.toolNames!.bash) expect(tools!.split(',')).not.toContain(shell);
  });

  it('an execute grant keeps the shell — gates that must run tests are not weakened', () => {
    const s = stub('claude', true);
    const { tools } = callHub('claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'bash,read_file,list_files,search' });
    for (const shell of claude.toolNames!.bash) expect(tools!.split(',')).toContain(shell);
  });

  it('a seam with NO grant is passed nothing — the default set is untouched', () => {
    const s = stub('claude', true);
    const { tools, argv } = callHub('claude', s, {});
    expect(argv.length, 'the runner was not invoked').toBeGreaterThan(0);
    expect(tools).toBeUndefined();
  });

  it('a list without the permitting flag binds nothing (the two travel together)', () => {
    const s = stub('claude', true);
    const { tools } = callHub('claude', s, { EPAM_ALLOWED_TOOLS: 'read_file' });
    expect(tools).toBeUndefined();
  });

  it('a runner whose --help does not advertise --tools is never handed the flag', () => {
    const s = stub('claude', false);
    const { tools, r } = callHub('claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file' });
    expect(r.status).toBe(0);
    expect(tools).toBeUndefined();
  });

  it('a runner that declares NO vocabulary binds no restriction — runner_tools_for_grant refuses, the flag is absent', () => {
    // The openrouter set names a runner "claude" that declares no toolNames (its seams run
    // through the epam arm, which enforces the grant itself). The guard says so with a non-zero
    // status and prints nothing, and the hub then passes no --tools rather than an empty one.
    const lib = join(ROOT, 'orchestrations/scripts/lib/runner-settings.sh');
    const direct = spawnSync('bash', ['-c', `source ${JSON.stringify(lib)}; RUNNER_FLAGS=(); apply_runner_settings claude ""; runner_tools_for_grant read_file,search; echo "rc=$?"`], {
      encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'openrouter', EPAM_PROJECT_CONFIG_DIR: '' },
    });
    expect(direct.stdout.trim()).toBe('rc=1');
    const s = stub('claude', true);
    const { tools, argv } = callHub('claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,search' }, 'openrouter');
    expect(argv.length).toBeGreaterThan(0);
    expect(tools).toBeUndefined();
  });

  it('the codemie arm binds through ITS runner declaration the same way', () => {
    const codemie = declaredRunner('codemie', 'codemie-claude');
    const s = stub('codemie-claude', true);
    const { tools } = callHub('codemie-claude', s, { AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,search' }, 'codemie');
    expect(tools).toBe(['read_file', 'search'].flatMap((t) => codemie.toolNames![t]).join(','));
  });

  it('the mockserver set (the £0 replays) declares the same vocabulary, so a rehearsal runs the posture a run does', () => {
    expect(declaredRunner('mockserver', 'claude').toolNames).toEqual(claude.toolNames);
  });
});
