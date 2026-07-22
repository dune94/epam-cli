/**
 * jira-client.js — hard write-block.
 *
 * This project never writes to any client system (Jira, Confluence, or
 * otherwise). A live run this session posted an unauthorized comment to a
 * real Jira ticket because the write-suppression flag (AC_GATE_SKIP_JIRA_
 * COMMENTS) was only checked at some call sites, not enforced at the point
 * of the actual HTTP write. A per-caller flag is not a guarantee — it only
 * takes one new call site (added anywhere in the pipeline, now or later)
 * that forgets to check it.
 *
 * The fix moves enforcement into jira-client.js's low-level request()
 * function: every write-capable call (addComment, transitionIssue,
 * updateField, createIssue) routes through request(), and any non-GET
 * method is rejected immediately, before any network call is attempted —
 * unconditionally, regardless of env flags or future code.
 *
 * These tests never touch the real network. They intercept Node's http/https
 * request() function itself and assert it is NEVER CALLED for a write verb,
 * and IS called for a read verb — proving the block happens before any
 * socket is opened, not just that the response happens to look like an error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const JIRA_CLIENT_PATH = require.resolve('../../../orchestrations/scripts/lib/jira-client');

function loadFreshJiraClient(env: Record<string, string>) {
  vi.resetModules();
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);
  const mod = require(JIRA_CLIENT_PATH);
  process.env = prevEnv;
  return mod;
}

describe('jira-client.js — hard write-block (never touches the network for writes)', () => {
  const ENV = { JIRA_URL: 'https://fake.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_TOKEN: 'tok' };
  let httpsRequestSpy: any;
  let httpRequestSpy: any;

  beforeEach(() => {
    vi.resetModules();
    const https = require('https');
    const http = require('http');
    httpsRequestSpy = vi.spyOn(https, 'request');
    httpRequestSpy = vi.spyOn(http, 'request');
  });

  afterEach(() => {
    httpsRequestSpy.mockRestore();
    httpRequestSpy.mockRestore();
  });

  it('addComment: rejects immediately, NEVER opens a socket', async () => {
    const jira = loadFreshJiraClient(ENV);
    await expect(jira.addComment('TEST-1', 'hello')).rejects.toThrow(/BLOCKED/i);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
  });

  it('updateField: rejects immediately, NEVER opens a socket', async () => {
    const jira = loadFreshJiraClient(ENV);
    await expect(jira.updateField('TEST-1', 'summary', 'x')).rejects.toThrow(/BLOCKED/i);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
  });

  it('createIssue: rejects immediately, NEVER opens a socket', async () => {
    const jira = loadFreshJiraClient(ENV);
    await expect(jira.createIssue('TEST', 'title', 'desc')).rejects.toThrow(/BLOCKED/i);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
  });

  it('transitionIssue: the write step (POST transition) never fires even if the read step (GET transitions list) is mocked to succeed', async () => {
    const jira = loadFreshJiraClient(ENV);
    // Mock the network layer so the GET sub-call inside transitionIssue "succeeds"
    // with a fake transitions list, isolating whether the POST write is reached.
    const https = require('https');
    (https.request as any).mockImplementation((_opts: any, cb: any) => {
      const res: any = {
        statusCode: 200,
        on: (event: string, handler: any) => {
          if (event === 'data') handler(JSON.stringify({ transitions: [{ id: '31', name: 'Done' }] }));
          if (event === 'end') handler();
        },
      };
      cb(res);
      return { on: () => {}, write: () => {}, end: () => {} };
    });
    await expect(jira.transitionIssue('TEST-1', 'Done')).rejects.toThrow(/BLOCKED/i);
  });

  it('getIssue (a read): DOES attempt the network call — reads are not blocked', async () => {
    const jira = loadFreshJiraClient(ENV);
    const https = require('https');
    (https.request as any).mockImplementation((_opts: any, cb: any) => {
      const res: any = {
        statusCode: 200,
        on: (event: string, handler: any) => {
          if (event === 'data') handler(JSON.stringify({ key: 'TEST-1' }));
          if (event === 'end') handler();
        },
      };
      cb(res);
      return { on: () => {}, write: () => {}, end: () => {} };
    });
    const result = await jira.getIssue('TEST-1');
    expect(httpsRequestSpy).toHaveBeenCalled();
    expect(result).toEqual({ key: 'TEST-1' });
  });

  it('searchIssues (a read): DOES attempt the network call — reads are not blocked', async () => {
    const jira = loadFreshJiraClient(ENV);
    const https = require('https');
    (https.request as any).mockImplementation((_opts: any, cb: any) => {
      const res: any = {
        statusCode: 200,
        on: (event: string, handler: any) => {
          if (event === 'data') handler(JSON.stringify({ issues: [] }));
          if (event === 'end') handler();
        },
      };
      cb(res);
      return { on: () => {}, write: () => {}, end: () => {} };
    });
    await jira.searchIssues('project = TEST');
    expect(httpsRequestSpy).toHaveBeenCalled();
  });

  it('the block fires regardless of AC_GATE_SKIP_JIRA_COMMENTS being unset or "0" — it is not a flag-gated check', async () => {
    const jira = loadFreshJiraClient({ ...ENV, AC_GATE_SKIP_JIRA_COMMENTS: '0' });
    await expect(jira.addComment('TEST-1', 'hello')).rejects.toThrow(/BLOCKED/i);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });

  it('source invariant: request() rejects before checking CONFIGURED for non-GET methods', () => {
    const src = require('fs').readFileSync(JIRA_CLIENT_PATH, 'utf8');
    const fnIdx = src.indexOf('function request(');
    const fnBody = src.slice(fnIdx, fnIdx + 600);
    const blockIdx = fnBody.indexOf('READ_ONLY_METHODS.has');
    const configuredIdx = fnBody.indexOf('if (!CONFIGURED)');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(configuredIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(configuredIdx);
  });

  it('source invariant: READ_ONLY_METHODS contains only GET', () => {
    const src = require('fs').readFileSync(JIRA_CLIENT_PATH, 'utf8');
    expect(src).toMatch(/READ_ONLY_METHODS\s*=\s*new Set\(\['GET'\]\)/);
  });
});
