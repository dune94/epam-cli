/**
 * THE LAUNCHER'S TICKET IS THE TICKET INGEST FETCHES.
 *
 * Live 2026-09-30: three runs launched as `pipeline --jira AMSD-2974` all worked on AMSD-1919. The
 * launcher exported JIRA_TICKET, nothing read it, and the project's config.env carried a pinned
 * JIRA_JQL ("issue = AMSD-1919") that ingest used instead — the banner said one ticket, the run
 * did another.
 *
 * EXECUTED: the real launcher in a fresh install of the committed tree, against a Jira stand-in at
 * the network edge that records the JQL it is asked and answers with no issues (so the run ends
 * at ingest). Every model endpoint points at a closed port — nothing can reach a real model.
 * The ticket key is built from a project's own declared prefix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureInstall } from '../../integration/lib/fixture-install';

const dirs: string[] = []; const children: ChildProcess[] = [];
let server: Server | null = null;
afterAll(() => {
  for (const c of children) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
  server?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Every process of this run, found by the install's own (unique, temporary) path — never by a pattern. */
function stopEverythingIn(install: string) {
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (Number(pid) === process.pid) continue;
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(install)) process.kill(Number(pid), 'SIGKILL');
    } catch { /* gone */ }
  }
}

describe('the launcher\'s ticket is the ticket ingest fetches', () => {
  it('pipeline --jira <key> asks Jira for exactly that key — never a JQL a project config pinned', async () => {
    const install = fixtureInstall(dirs);
    // What the launcher tells an operator to do on a fresh install; every value this run needs
    // arrives in its environment below.
    copyFileSync(join(install, '.env.example'), join(install, '.env'));
    const projects = join(install, 'orchestrations/projects');
    // A project whose config declares a tracker key AND pins a JQL of its own — the live shape.
    const declared = readdirSync(projects).map((p) => {
      const f = join(projects, p, 'config.env');
      const t = existsSync(f) ? readFileSync(f, 'utf8') : '';
      return { p, key: (/^JIRA_PROJECT_KEY=(\S+)/m.exec(t) || [])[1], pinned: /^JIRA_JQL=/m.test(t) };
    }).find((x) => x.key);
    expect(declared, 'no project declares a tracker key').toBeTruthy();
    const ticket = `${declared!.key}-${900000 + (process.pid % 99999)}`;

    const asked: string[] = [];
    server = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://x');
      if (u.searchParams.get('jql')) asked.push(u.searchParams.get('jql')!);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issues: [], total: 0, isLast: true }));
    });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', () => ok()));
    const jiraUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const closed = 'http://127.0.0.1:9';
    const codelines = mkdtempSync(join(tmpdir(), 'launcher-ticket-cl-')); dirs.push(codelines);

    const child = spawn('bash', [join(install, 'orchestrations/scripts/pipeline'), '--jira', ticket], {
      cwd: install, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JIRA_URL: jiraUrl, JIRA_EMAIL: 'rehearsal@example.invalid', JIRA_TOKEN: 'not-a-token', EPAM_PROVIDER_SET: 'mockserver',
        JIRA_CODELINE_ROOT: codelines, EPAM_SKIP_CONTAINER_RESTART: '1', NODE_BIN: process.execPath,
        ANTHROPIC_BASE_URL: closed, OPENAI_BASE_URL: closed, EPAM_CODEMIE_WEB_URL: closed, JIRA_TICKET: '', JIRA_JQL: '' },
    });
    children.push(child);
    let log = ''; child.stdout!.on('data', (d) => { log += d; }); child.stderr!.on('data', (d) => { log += d; });
    // The launcher hands the run on and exits; the run is waited for, not the launcher.
    for (let i = 0; i < 600 && !asked.length; i += 1) await new Promise((ok) => setTimeout(ok, 500));
    stopEverythingIn(install);

    const tail = log.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-40).join('\n');
    expect(asked.length, `ingest never asked the tracker anything — log tail:\n${tail}`).toBeGreaterThan(0);
    for (const jql of asked) {
      expect(jql, `ingest asked for something other than the launched ticket ${ticket}`).toContain(ticket);
    }
  }, 600_000);
});
