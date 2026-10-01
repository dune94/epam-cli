/**
 * DISCOVERY ACCEPTS A CANDIDATE AS IT WAS SHOWN — RELATIVE — AND RECORDS THE REAL REPOSITORY.
 *
 * Operator, 2026-10-01: relative paths only in prompts. Candidates now reach the discovery agent
 * relative to where it works; its validator refused any answer that was not absolute ("that path is
 * not absolute"), so a correct answer copied from the prompt failed three times and ingest stopped
 * (brownfield rehearsal, 2026-10-01).
 *
 * EXECUTED: the real discovery CLI on a real git estate, its model a stub answering with the paths
 * exactly as the prompt listed them.
 */
import { describe, it, expect } from 'vitest';
import { runDiscovery, estatePath } from '../helpers/discovery-receiver';

describe('discovery accepts the path it showed', () => {
  it('an answer naming candidates as listed — "." and "repo-b" — selects the real repositories', () => {
    let work = '';
    const r = runDiscovery({
      estate: { 'repo-a': { 'package.json': '{"name":"a"}' }, 'repo-b': { 'package.json': '{"name":"b"}' } },
      issues: [{ key: 'X-1', summary: 'Change both', description: 'repo-a and repo-b both need it' }],
      env: { PROJECT_ROOT: '{WORK}/estate/repo-a', JIRA_CODELINE_ROOT: '{WORK}/estate' },
      onWork: (w) => { work = w; },
      reply: () => JSON.stringify({ codelines: [
        { name: 'a', path: '.', reason: 'it is where the change lands', evidence: ['package.json'] },
        { name: 'b', path: 'repo-b', reason: 'it also needs it', evidence: ['package.json'] },
      ], unsure: [] }),
    });
    expect(r.code, `${r.stderr.slice(-1500)}`).toBe(0);
    const paths = (r.out?.codelines || []).map((c: { path: string }) => c.path).sort();
    expect(paths).toEqual([estatePath(work, 'repo-a'), estatePath(work, 'repo-b')].sort());
  });

  it('an answer naming something that was not listed is still refused', () => {
    const r = runDiscovery({
      estate: { 'repo-a': { 'package.json': '{"name":"a"}' } },
      issues: [{ key: 'X-1', summary: 's', description: 'd' }],
      env: { PROJECT_ROOT: '{WORK}/estate/repo-a', JIRA_CODELINE_ROOT: '{WORK}/estate', EPAM_CONTENT_RETRY_ATTEMPTS: '1' },
      reply: () => JSON.stringify({ codelines: [{ name: 'z', path: 'not-a-repo', reason: 'r', evidence: ['x'] }], unsure: [] }),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not one of the repositories listed/);
  });
});
