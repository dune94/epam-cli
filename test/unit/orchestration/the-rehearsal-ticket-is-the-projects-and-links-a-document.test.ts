/**
 * THE REHEARSAL TICKET IS THE PROJECT'S, AND IT LINKS A DOCUMENT.
 *
 * The ticket mock1-paused-run.sh served was three string constants in the launcher — a project
 * fact inside the pipeline — and its description carried no link, so the ticket-links seam had
 * nothing to review and could never execute for this project (£0 brownfield harness run 12,
 * 2026-09-14). The project declares its tracker issues (tracker-issues.json, with the documents
 * they link); the stub tracker serves them, and serves each linked document itself at the URL
 * the description carries — no network, nothing invented by the launcher.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const seeded = readdirSync(PROJECTS).filter((d) => existsSync(join(PROJECTS, d, 'seed')));
const SERVER = join(ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js');
const LAUNCHER = readFileSync(join(ROOT, 'orchestrations/scripts/mock1-paused-run.sh'), 'utf8');
const kids: any[] = [];
afterAll(() => { for (const k of kids) k.kill(); });

async function serve(issuesFile: string): Promise<string> {
  const c = spawn(process.execPath, [SERVER, '--issues', issuesFile], { stdio: ['ignore', 'pipe', 'pipe'] }); kids.push(c);
  return new Promise((res, rej) => {
    let out = ''; c.stdout.on('data', (d) => { out += d; const m = out.match(/LISTENING:(\d+)/); if (m) res(`http://127.0.0.1:${m[1]}`); });
    c.stderr.on('data', (d) => rej(new Error(String(d))));
  });
}

describe("the rehearsal ticket is the project's, and links a document", () => {
  it('a project owns a seed — otherwise nothing below is tested', () => { expect(seeded.length).toBeGreaterThan(0); });
  it.each(seeded)('%s declares its tracker issues, and every issue links a document it also declares', (name) => {
    const f = join(PROJECTS, name, 'tracker-issues.json');
    expect(existsSync(f), `${name} declares no tracker-issues.json`).toBe(true);
    const issues = JSON.parse(readFileSync(f, 'utf8'));
    expect(Array.isArray(issues) && issues.length).toBeTruthy();
    for (const i of issues) {
      expect(typeof i.key).toBe('string'); expect(typeof i.summary).toBe('string'); expect(typeof i.description).toBe('string');
      const links = [...i.description.matchAll(/\{\{TRACKER_URL\}\}\/docs\/([^\s)]+)/g)].map((m) => m[1]);
      expect(links.length, `${i.key} links no document`).toBeGreaterThan(0);
      for (const l of links) expect(typeof (i.docs || {})[l], `${i.key} links ${l} but declares no such document`).toBe('string');
    }
  });
  it.each(seeded)('%s: the stub tracker serves the issue with the link resolved to itself, and serves the document', async (name) => {
    const base = await serve(join(PROJECTS, name, 'tracker-issues.json'));
    const issues = JSON.parse(readFileSync(join(PROJECTS, name, 'tracker-issues.json'), 'utf8'));
    const r = await fetch(`${base}/rest/api/3/issue/${issues[0].key}`); const j: any = await r.json();
    expect(j.fields.description).not.toContain('{{TRACKER_URL}}');
    expect(j.fields.description).toContain(`${base}/docs/`);
    const link = j.fields.description.match(/(http:\/\/127\.0\.0\.1:\d+\/docs\/[^\s)]+)/)![1];
    const d = await fetch(link);
    expect(d.status).toBe(200);
    expect(await d.text()).toBe(issues[0].docs[link.split('/docs/')[1]]);
  });
  it.each(seeded)('%s: the ticket carries acceptance criteria the tracker client extracts — the elaboration seam has work', (name) => {
    // ac-elaboration applies to brownfield tickets whose ACs the classifier finds enrichable; a
    // ticket with none skips AC processing entirely (lib/ac-gate.js skipAcProcessing), so the
    // seam never executed on this project (£0 brownfield harness run 16, 2026-09-14).
    // Through the real client's normalisation of an issue shaped as the stub tracker serves it.
    const { normalizeIssue } = require(join(ROOT, 'orchestrations/scripts/lib/jira-client.js'));
    const issues = JSON.parse(readFileSync(join(PROJECTS, name, 'tracker-issues.json'), 'utf8'));
    for (const i of issues) {
      const raw = { key: i.key, fields: { summary: i.summary, description: i.description, status: { name: 'To Do' }, labels: [], issuetype: { name: 'Bug' }, assignee: null, priority: { name: 'Medium' } } };
      const n = normalizeIssue(raw);
      expect((n.acceptanceCriteria || []).length, `${i.key} carries no acceptance criteria the client can extract`).toBeGreaterThan(0);
    }
  });
  it('the launcher serves the project\'s issues and carries no ticket of its own', () => {
    expect(LAUNCHER).toMatch(/--issues "\$PROJECT_CONFIG_DIR\/tracker-issues\.json"/);
    expect(LAUNCHER).not.toMatch(/^(STORY_ID|SUMMARY|DESCRIPTION)=/m);
  });
});
