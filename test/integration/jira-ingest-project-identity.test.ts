/**
 * INTEGRATION — a run's PRD carries the RUNNING project's identity.
 *
 * This exists because four assertions of the form `expect(INGEST).toMatch(/--template/)`
 * certified that "the PRD template is configurable per project" while every Jira-sourced
 * run inherited a different project's `project` block. mock1 run 20260805T192100Z executed
 * hello-dolly and produced project.name "skyscanner-app". Giving hello-dolly its own
 * prd.canonical.json changed nothing, because nothing read it — and no test noticed,
 * because no test ever ran the ingest and looked at what came out.
 *
 * So this one runs the real chain: the real mock Jira HTTP server, the real
 * ingest-jira-tickets.sh, the real ac-gate.js, the real synthesize-prd-from-jira.js — and
 * reads project.name out of the PRD that lands on disk. Nothing is extracted, stubbed or
 * reimplemented above the Jira HTTP boundary.
 *
 * It costs no tokens: a brownfield ticket with no ACs takes the codeline-only path, which
 * short-circuits before any LLM call under AC_GATE_DRY_RUN. That is the same path a real
 * brownfield run takes.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../');
const INGEST = join(REPO, 'orchestrations/scripts/ingest-jira-tickets.sh');
const JIRA_STUB = join(REPO, 'test/fixtures/mock-pipeline/mock-jira-server.js');
const NODE = process.execPath;

const servers: ChildProcess[] = [];
afterAll(() => servers.forEach((s) => s.kill()));

/** Starts the real mock Jira server and waits for the port it prints. */
async function startJira(dir: string): Promise<number> {
  const out = join(dir, 'jira.out');
  writeFileSync(out, '');
  const proc = spawn(NODE, [JIRA_STUB, 'MOCK-1', 'greeting is wrong', 'hello.ts returns the wrong greeting'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(proc);
  let buf = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jira stub never reported a port. out:\n${buf}`)), 20000);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/LISTENING:(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
  });
}

/** Runs the REAL ingest end to end and returns the PRD it wrote. */
function runIngest(opts: { port: number; projectConfigDir?: string; jiraPrdTemplate?: string }) {
  const work = mkdtempSync(join(tmpdir(), 'ingest-it-'));
  const prd = join(work, 'out-prd.json');
  const r = spawnSync('bash', [INGEST], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: REPO,
    env: {
      ...process.env,
      // The codeline-only path: brownfield, no ACs, no LLM call.
      AC_GATE_DRY_RUN: '1',
      EPAM_BROWNFIELD: '1',
      JIRA_CODELINES: 'alpha',
      JIRA_WORKTREE_ALPHA: join(work, 'alpha'),
      JIRA_URL: `http://127.0.0.1:${opts.port}`,
      JIRA_EMAIL: 'a@b.c',
      JIRA_TOKEN: 't',
      JIRA_PROJECT_KEY: 'MOCK',
      EPAM_PROJECT_CONFIG_DIR: opts.projectConfigDir ?? '',
      JIRA_PRD_TEMPLATE: opts.jiraPrdTemplate ?? '',
      PRD_FILE: prd,
    },
  });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    status: r.status,
    log,
    prd: existsSync(prd) ? JSON.parse(readFileSync(prd, 'utf8')) : null,
  };
}

/** A project directory that owns its identity, as every project is required to. */
function projectConfig(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'prd.canonical.json'),
    JSON.stringify({
      id: name,
      project: { name, stack: 'typescript', outputDir: '', outputDirs: [] },
      stories: [],
      implementationOrder: { core: [] },
    }),
  );
  return dir;
}

describe('the synthesized PRD carries the running project\'s identity', () => {
  // ONE stub for the file. The server is stateless and serves the same ticket to every
  // caller; starting four of them made the third test hit the 120s spawn timeout.
  let port = 0;
  beforeAll(async () => {
    port = await startJira(mkdtempSync(join(tmpdir(), 'jira-')));
  }, 30000);

  it('THE REGRESSION: project.name is the project being run, not another one', () => {
    const cfg = projectConfig('project-under-test');

    const r = runIngest({ port, projectConfigDir: cfg });

    expect(r.status, `ingest failed:\n${r.log.slice(-1500)}`).toBe(0);
    expect(r.prd, 'ingest wrote no PRD at all').not.toBeNull();
    expect(
      r.prd.project?.name,
      'mock1 run 20260805T192100Z ran hello-dolly and shipped project.name ' +
        '"skyscanner-app". Four source-text assertions passed while it did.',
    ).toBe('project-under-test');
  }, 150000);

  it('the ticket still becomes a routed story — identity is not fixed by dropping the work', () => {
    const r = runIngest({ port, projectConfigDir: projectConfig('routed') });
    expect(r.prd.stories.length, 'the ingested ticket vanished').toBeGreaterThan(0);
    expect(r.prd.stories[0].codeline, 'a story with no codeline is unroutable').toBeTruthy();
  }, 150000);

  it('an explicit JIRA_PRD_TEMPLATE still wins over the project\'s own canonical', () => {
    const explicitDir = projectConfig('explicit-choice');
    const r = runIngest({
      port,
      projectConfigDir: projectConfig('derived-would-be-this'),
      jiraPrdTemplate: join(explicitDir, 'prd.canonical.json'),
    });
    expect(r.prd.project?.name).toBe('explicit-choice');
  }, 150000);

  it('no LLM was called — the brownfield-without-ACs path must stay free', () => {
    const r = runIngest({ port, projectConfigDir: projectConfig('no-spend') });
    // The codeline-only path DOES emit a verdict line — it says the AC work was skipped.
    // What must not appear is evidence of the model actually classifying ACs.
    expect(
      r.log,
      'AC classification on a brownfield ticket with no ACs is the token waste that was ' +
        'already removed once; it must not creep back',
    ).toMatch(/AC processing skipped/);
    expect(r.log, 'a gaps/elaboration section means the AC classifier ran').not.toMatch(/enrichedAcs|gaps:\s*\[[^\]]/);
  }, 150000);
});
