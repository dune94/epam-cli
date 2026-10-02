/**
 * A CODELINE THAT CONSUMES A SHARED CHANGE IS VERIFIED THROUGH ITS OWN BEHAVIOUR, NOT ITS MANIFEST.
 *
 * Live 2026-10-02, AMSD-2974 (a shared library and three consuming sites), run 20261001T181327Z: the
 * detective reported each site's dependency entry as shared and out of range. The spec agent was
 * never shown that fact — the fix-site block carried only file, function and reason — so it scoped
 * the site's verification to "confirming the dependency range permits consumption", wrote criteria
 * about the manifest, the VC guard rejected those as mechanism, and the description and the criteria
 * left contradicted each other. The change reviewer rejected it (upexpress once, metrolinx three
 * times), and every rejection re-ran the whole spec agent.
 *
 * EXECUTED: the real runSpecAgent, with a stand-in runner that records the prompt it is given and a
 * detective stand-in that answers with the finding shape the live detective gave. The project prompt
 * is the template copied into a temporary project, as provisioning does.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations');
const work = mkdtempSync(join(tmpdir(), 'shared-consumer-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const proj = join(work, 'project');
mkdirSync(join(proj, 'prompts'), { recursive: true });
for (const f of readdirSync(join(ORCH, 'prompts/templates')).filter((n) => n.startsWith('spec-agent-openspec'))) {
  copyFileSync(join(ORCH, 'prompts/templates', f), join(proj, 'prompts', f));
}
const runner = join(work, 'runner.sh');
writeFileSync(runner, `#!/bin/bash\n{ echo "ARGS: $*"; cat; } >> "$PROBE_OUT"\n`);
chmodSync(runner, 0o755);

const shared = { package: '@scope/lib', providedBy: 'lib', consumers: [{ codeline: 'site', declaredRange: '^7', receivesChange: false }], note: '' };

async function promptFor(findings: any[], probe: string) {
  const out = join(work, `${probe}.txt`);
  process.env.PROBE_OUT = out;
  process.env.EPAM_PROJECT_CONFIG_DIR = proj;
  process.env.SPEC_MODE_NO_MAIN = '1';
  process.env.EPAM_BROWNFIELD = '1';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spec = require(join(ORCH, 'scripts/spec-mode-runner.js'));
  const story = { id: 'S-1', title: 't', description: 'd', codeline: 'site', codelines: ['lib', 'site'], acceptanceCriteria: [] };
  const logDir = join(work, `logs-${probe}`); mkdirSync(logDir, { recursive: true });
  await spec.runSpecAgent({
    promptExec: { cmd: runner, args: [] }, agent: 'openspec', story, phase: 'core', runId: 'R', logDir,
    prd: { stories: [story], project: { outputDir: work, outputDirs: [] } },
    runDetective: async () => findings,
  });
  expect(existsSync(out), 'the runner was never asked — nothing below means anything').toBe(true);
  const text = readFileSync(out, 'utf8');
  expect(text, 'the prompt carried no located fix sites').toContain('LOCATED FIX SITE');
  return text;
}

describe('the spec agent is told what is shared and how a consumer is verified', () => {
  it('a shared, out-of-range finding reaches the prompt with its facts and the verification rule', async () => {
    const p = await promptFor([{ file: 'package.json', function: '', reason: 'bump', shared }], 'shared');
    expect(p).toContain('@scope/lib');
    expect(p).toContain('^7');
    expect(p).toContain('SHARED WITH ANOTHER CODELINE');
  }, 120000);

  it('a story with nothing shared gets no such section', async () => {
    const p = await promptFor([{ file: 'src/a.ts', function: 'f', reason: 'r' }], 'plain');
    expect(p).not.toContain('SHARED WITH ANOTHER CODELINE');
    expect(p).not.toContain('@scope/lib');
  }, 120000);
});

describe('the words are in the template layer and name no project', () => {
  it('spec-shared-consumer names none of the projects', () => {
    const raw = readFileSync(join(ORCH, 'prompts/templates/spec-shared-consumer.json'), 'utf8').toLowerCase();
    const projects = readdirSync(join(ORCH, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(projects.length).toBeGreaterThan(0);
    for (const n of projects) expect(raw).not.toContain(n.toLowerCase());
  });
});
