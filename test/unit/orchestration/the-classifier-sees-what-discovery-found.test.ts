/**
 * THE AC CLASSIFIER SEES WHAT DISCOVERY FOUND OUT ABOUT EACH CODELINE.
 *
 * Live 2026-10-01 (AMSD-2974): discovery found four codelines, each with a reason (the shared
 * component library; three sites that mount it). The AC gate's classifier was shown only their
 * NAMES — `"gotransit" — gotransit` — filed the spanning story under one, and the PRD's scope became
 * that one codeline: the three sites would never have been touched. The reasons were never exported.
 *
 * EXECUTED: the real exports handler on a discovery artifact, its output exported the way
 * ingest-jira-tickets.sh exports it, and the real classifier prompt rendered in that environment.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dir = mkdtempSync(join(tmpdir(), 'classifier-sees-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CODELINES = [
  { name: 'shared-lib', path: join(dir, 'shared-lib'), reason: 'Defines the component itself;\nevery site mounts the "shared" version.' },
  { name: 'site-a', path: join(dir, 'site-a'), reason: 'A consumer site that mounts the component in 61 places.' },
];

/** The handler's KEY="value" lines, exported as ingest does: split on the first =, quotes removed. */
function exportedEnv(): Record<string, string> {
  const artifact = join(dir, 'discovery.json');
  writeFileSync(artifact, JSON.stringify({ codelines: CODELINES }));
  const r = spawnSync(process.execPath, [join(LIB, 'handlers/codeline-discovery-exports.js'), artifact], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('='); if (i <= 0) continue;
    env[line.slice(0, i)] = line.slice(i + 1).replace(/"/g, '');
  }
  return env;
}

describe('the classifier sees what discovery found', () => {
  it('each codeline\'s reason from discovery is in the classifier\'s prompt', () => {
    const env = exportedEnv();
    const names = env.JIRA_CODELINES.split(',');
    const r = spawnSync(process.execPath, ['-e', `
      const { buildClassificationPrompt } = require(${JSON.stringify(join(LIB, 'ac-gate.js'))});
      process.stdout.write(buildClassificationPrompt({ jiraKey: 'X-1', title: 't', description: 'd', acceptanceCriteria: [] }, ${JSON.stringify(names)}));
    `], { encoding: 'utf8', env: { ...process.env, ...env } });
    expect(r.status, r.stderr).toBe(0);
    for (const c of CODELINES) {
      const said = c.reason.replace(/\s+/g, ' ').replace(/"/g, '');
      expect(r.stdout, `the classifier was not told what discovery found about ${c.name}`).toContain(said);
    }
  });

  it('a reason can never break the KEY="value" lines ingest reads', () => {
    const env = exportedEnv();
    expect(env.JIRA_CODELINES).toBe(CODELINES.map((c) => c.name).join(','));
    for (const k of Object.keys(env)) expect(k).toMatch(/^[A-Z_][A-Z0-9_]*$/);
  });
});
