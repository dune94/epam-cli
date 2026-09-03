/**
 * STAGE 0+1 OF THE BROWNFIELD PIPELINE — 116 lines, no test.
 *
 * It pulls tickets, runs the AC gate, and synthesises the PRD every later stage reads. Two of its
 * documented behaviours decide whether a run happens at all:
 *
 *   ON INSUFFICIENT ACs IT EXITS 2, and the caller must halt. A run that proceeds past that is a
 *   run implementing tickets nobody specified.
 *
 *   IT REQUIRES CREDENTIALS. Reaching out without them produces an auth failure deep in a client
 *   integration rather than a statement at the door.
 *
 * Everything below runs offline: the credential and argument checks happen before any network call,
 * which is what makes them the right things to assert.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/ingest-jira-tickets.sh');

function ingest(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      NODE_BIN: process.execPath,
      EPAM_COVERAGE_GATED: '0',
      // Cleared unless a case sets them: the point is what happens without credentials.
      JIRA_URL: '', JIRA_EMAIL: '', JIRA_TOKEN: '', JIRA_PROJECT_KEY: '',
      ...env,
    },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const creds = {
  JIRA_URL: 'https://example.invalid',
  JIRA_EMAIL: 'someone@example.invalid',
  JIRA_TOKEN: 'a-token',
  JIRA_PROJECT_KEY: 'AMSD',
};

describe('the Jira ingest refuses at the door, not deep in a client integration', () => {
  it.each(['JIRA_URL', 'JIRA_EMAIL', 'JIRA_TOKEN'])('refuses with %s missing, and names it', (missing) => {
    const env: Record<string, string> = { ...creds, [missing]: '' };
    const r = ingest(['--project', 'AMSD'], env);
    expect(r.code, `${missing} was missing and the ingest reached out anyway`).not.toBe(0);
    expect(r.out, 'the refusal does not name what is missing').toMatch(/JIRA_URL|JIRA_EMAIL|JIRA_TOKEN/);
  }, 180_000);

  it('names ALL THREE in one message rather than one per attempt', () => {
    // Reporting them one at a time makes an operator run it three times to learn what to set.
    const r = ingest(['--project', 'AMSD']);
    expect(r.out).toMatch(/JIRA_URL/);
    expect(r.out).toMatch(/JIRA_EMAIL/);
    expect(r.out).toMatch(/JIRA_TOKEN/);
  }, 180_000);

  it('refuses without a project, because a JQL scope with no project is every ticket', () => {
    const r = ingest([], creds);
    expect(r.code, 'it ran with no project scope at all').not.toBe(0);
  }, 180_000);

  it('an unknown flag is refused rather than silently ignored', () => {
    // Silently ignoring it means an operator believes they scoped an ingest that was never scoped —
    // and the scope here decides which tickets become a run.
    const r = ingest(['--project', 'AMSD', '--not-a-flag'], creds);
    expect(r.code, 'an unknown flag was accepted, so a mis-typed scope would pass unnoticed')
      .not.toBe(0);
  }, 180_000);

  it('--out-prd is honoured rather than writing wherever a default points', () => {
    // A default output path once overwrote another project's PRD.
    const out = join(mkdtempSync(join(tmpdir(), 'ingest-')), 'prd.json');
    const r = ingest(['--project', 'AMSD', '--out-prd', out, '--dry-run'], creds);
    // It cannot be checked further offline: the write happens after the fetch, and the fetch is the
    // thing this test deliberately does not do. What IS assertable is that the flag got past
    // argument validation rather than being rejected as unknown.
    expect(r.out, '--out-prd was rejected before the ingest began').toMatch(/Pulling|ingest/i);
    expect(r.out, '--out-prd was treated as an unknown option').not.toMatch(/unknown option/i);
  }, 180_000);

  it('--dry-run reaches the same argument checks — it is not a separate, weaker path', () => {
    const r = ingest(['--dry-run'], creds);
    expect(r.code, '--dry-run skipped the project-scope requirement').not.toBe(0);
  }, 180_000);
});
