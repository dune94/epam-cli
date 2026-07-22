/**
 * jira-client.js — no write capability exists, at all.
 *
 * This project never writes to any client system (Jira, Confluence, or
 * otherwise). Two escalating incidents this session led to two escalating
 * fixes:
 *
 *   1. An unauthorized AC-remediator writeback posted a live comment to a
 *      real Jira ticket (a per-caller flag was checked in some places, not
 *      others). Fix: move enforcement into jira-client.js's request()
 *      function — reject any non-GET method before any socket opens.
 *
 *   2. The user then set an absolute standing rule: "no jira updates are
 *      allowed anywhere anytime — no flags etc nothing." A runtime check is
 *      still a flag, conceptually — it can be misconfigured, monkey-patched,
 *      or have its condition inverted by a future edit. Fix: DELETE the
 *      write-capable functions entirely. addComment, transitionIssue,
 *      updateField, and createIssue do not exist in this file. request()
 *      takes no method parameter — it only ever issues GET. A write call
 *      cannot be constructed here, not "is rejected when constructed."
 *
 * These tests prove the stronger property: the functions are absent from
 * the module's exports AND from its source entirely, and the only HTTP
 * verb request() can send is GET.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const JIRA_CLIENT_PATH = require.resolve('../../../orchestrations/scripts/lib/jira-client');

function loadFreshJiraClient(env: Record<string, string>) {
  vi.resetModules();
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);
  const mod = require(JIRA_CLIENT_PATH);
  process.env = prevEnv;
  return mod;
}

describe('jira-client.js — write functions do not exist (not blocked — absent)', () => {
  const ENV = { JIRA_URL: 'https://fake.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_TOKEN: 'tok' };

  it('addComment is not exported', () => {
    const jira = loadFreshJiraClient(ENV);
    expect(jira.addComment).toBeUndefined();
  });

  it('transitionIssue is not exported', () => {
    const jira = loadFreshJiraClient(ENV);
    expect(jira.transitionIssue).toBeUndefined();
  });

  it('updateField is not exported', () => {
    const jira = loadFreshJiraClient(ENV);
    expect(jira.updateField).toBeUndefined();
  });

  it('createIssue is not exported', () => {
    const jira = loadFreshJiraClient(ENV);
    expect(jira.createIssue).toBeUndefined();
  });

  it('the exported API surface is exactly the read-only set — nothing else', () => {
    const jira = loadFreshJiraClient(ENV);
    const exported = Object.keys(jira).sort();
    expect(exported).toEqual(
      ['CONFIGURED', 'getBoardIssues', 'getIssue', 'getProjectIssues', 'searchIssues'].sort()
    );
  });

  it('source invariant: no function named addComment/transitionIssue/updateField/createIssue exists anywhere in the file', () => {
    const src = readFileSync(JIRA_CLIENT_PATH, 'utf8');
    expect(src).not.toMatch(/function\s+addComment/);
    expect(src).not.toMatch(/function\s+transitionIssue/);
    expect(src).not.toMatch(/function\s+updateField/);
    expect(src).not.toMatch(/function\s+createIssue/);
  });

  it('source invariant: no write HTTP verb string (POST/PUT/PATCH/DELETE) appears anywhere in the file', () => {
    const src = readFileSync(JIRA_CLIENT_PATH, 'utf8');
    expect(src).not.toMatch(/'POST'|"POST"|'PUT'|"PUT"|'PATCH'|"PATCH"|'DELETE'|"DELETE"/);
  });

  it("source invariant: request() takes no method parameter — only GET is hardcoded", () => {
    const src = readFileSync(JIRA_CLIENT_PATH, 'utf8');
    const fnIdx = src.indexOf('function request(');
    const fnSignature = src.slice(fnIdx, src.indexOf(')', fnIdx) + 1);
    expect(fnSignature).toBe('function request(path)');
    const fnBody = src.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toMatch(/method:\s*'GET'/);
  });
});

describe('jira-client.js — reads still work normally (GET is unaffected)', () => {
  const ENV = { JIRA_URL: 'https://fake.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_TOKEN: 'tok' };
  let httpsRequestSpy: any;

  beforeEach(() => {
    vi.resetModules();
    const https = require('https');
    httpsRequestSpy = vi.spyOn(https, 'request');
  });

  afterEach(() => {
    httpsRequestSpy.mockRestore();
  });

  it('getIssue: issues a real GET request', async () => {
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
    const callOpts = (https.request as any).mock.calls[0][0];
    expect(callOpts.method).toBe('GET');
    expect(result).toEqual({ key: 'TEST-1' });
  });

  it('searchIssues: issues a real GET request', async () => {
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
    const callOpts = (https.request as any).mock.calls[0][0];
    expect(callOpts.method).toBe('GET');
  });
});
