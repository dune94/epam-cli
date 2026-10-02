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
    // The library lane's spec once declared the sites' change "tracked separately", which the
    // ticket never said, and every later lane inherited it (2026-10-02).
    expect(p).toContain('NEVER DECLARE ANOTHER CODELINE');
  }, 120000);

  it('a story with nothing shared gets no such section', async () => {
    const p = await promptFor([{ file: 'src/a.ts', function: 'f', reason: 'r' }], 'plain');
    expect(p).not.toContain('SHARED WITH ANOTHER CODELINE');
    expect(p).not.toContain('@scope/lib');
  }, 120000);
});

/**
 * EVERY OTHER CONSUMER OF THE DETECTIVE'S FINDINGS (full review, 2026-10-02). Four did not see
 * `shared`: VC regeneration (its own site list), speckit (can rewrite the description), and both
 * diff reviewers (team-lead-review, code-review-cycle — one builder, lib/review-criteria.sh).
 */
const sharedFinding = { codeline: 'site', file: 'package.json', function: '', reason: 'bump', changeRequired: true, shared };
const plainFinding = { codeline: 'site', file: 'src/a.ts', function: 'f', reason: 'r', changeRequired: true };

function captureRunner(name: string) {
  const out = join(work, `${name}.txt`);
  const sh = join(work, `${name}.sh`);
  writeFileSync(sh, `#!/bin/bash\n{ echo "ARGS: $*"; cat; } >> ${JSON.stringify(out)}\n`);
  chmodSync(sh, 0o755);
  return { sh, out };
}

describe('VC regeneration is shown what is shared', () => {
  async function regen(findings: any[], name: string) {
    const r = captureRunner(name);
    const prev = process.env.AI_RUNNER_CMD;
    process.env.AI_RUNNER_CMD = r.sh;
    process.env.SPEC_MODE_NO_MAIN = '1';
    // A label only: the stand-in runner is what answers, whatever provider it is told.
    process.env.EPAM_ORCHESTRATION_PROVIDER = process.env.EPAM_ORCHESTRATION_PROVIDER || 'openrouter';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const spec = require(join(ORCH, 'scripts/spec-mode-runner.js'));
      const logDir = join(work, `logs-${name}`); mkdirSync(logDir, { recursive: true });
      await spec.regenerateVcViaOpenspec({ story: { id: 'S-1', title: 't', description: 'd', codeline: 'site', codelines: ['lib', 'site'] }, flags: ['x'], cycle: 1, logDir, findings });
    } finally { if (prev === undefined) delete process.env.AI_RUNNER_CMD; else process.env.AI_RUNNER_CMD = prev; }
    expect(existsSync(r.out), 'the regeneration never asked its model').toBe(true);
    const text = readFileSync(r.out, 'utf8');
    expect(text).toContain('THE FIX SITE');
    return text;
  }
  it('a shared finding reaches the regeneration prompt with the rule', async () => {
    const t = await regen([sharedFinding], 'regen-shared');
    expect(t).toContain('@scope/lib');
    expect(t).toContain('SHARED WITH ANOTHER CODELINE');
  }, 120000);
  it('nothing shared, no section', async () => {
    const t = await regen([plainFinding], 'regen-plain');
    expect(t).not.toContain('SHARED WITH ANOTHER CODELINE');
  }, 120000);
});

describe('speckit is shown what is shared', () => {
  async function speckit(findings: any[], name: string, refineExistingChildren = false) {
    const r = captureRunner(name);
    process.env.SPEC_MODE_NO_MAIN = '1';
    process.env.EPAM_BROWNFIELD = '1';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const spec = require(join(ORCH, 'scripts/spec-mode-runner.js'));
    const logDir = join(work, `logs-${name}`); mkdirSync(logDir, { recursive: true });
    const story = { id: 'S-1', title: 't', description: 'd', codeline: 'site', codelines: ['lib', 'site'], acceptanceCriteria: [], fixSiteAnalysis: findings };
    await spec.runSpeckitReview({ promptExec: { cmd: r.sh, args: [] }, story, openspecOutput: { acceptanceCriteria: [], notes: '', splitStories: [] }, phase: 'core', runId: 'R', logDir, refineExistingChildren });
    expect(existsSync(r.out), 'speckit never asked its model').toBe(true);
    const text = readFileSync(r.out, 'utf8');
    expect(text).toContain(refineExistingChildren ? 'ORIGINAL PARENT STORY CONTEXT' : 'OPENSPEC\'S OUTPUT');
    return text;
  }
  it('a shared finding reaches the speckit prompt with the rule', async () => {
    const t = await speckit([sharedFinding], 'speckit-shared');
    expect(t).toContain('@scope/lib');
    expect(t).toContain('SHARED WITH ANOTHER CODELINE');
  }, 120000);
  it('the refine path is shown it too', async () => {
    const t = await speckit([sharedFinding], 'speckit-refine-shared', true);
    expect(t).toContain('@scope/lib');
    expect(t).toContain('SHARED WITH ANOTHER CODELINE');
  }, 120000);
  it('nothing shared, no section', async () => {
    const t = await speckit([plainFinding], 'speckit-plain');
    expect(t).not.toContain('SHARED WITH ANOTHER CODELINE');
  }, 120000);
});

describe('both diff reviewers are shown what is shared (lib/review-criteria.sh, one builder)', () => {
  const { spawnSync } = require('node:child_process');
  function reviewBlock(perCodeline: any, name: string) {
    const prd = join(work, `${name}-prd.json`);
    writeFileSync(prd, JSON.stringify({
      project: { outputDir: '/w/codelines/site.example', outputDirs: [{ codeline: 'lib', path: '/w/codelines/lib-repo' }, { codeline: 'site', path: '/w/codelines/site.example' }] },
      stories: [{ id: 'S-1', codeline: 'site', codelines: ['lib', 'site'], verificationCriteria: ['the toast is announced'], fixSiteAnalysis: perCodeline.site, fixSiteAnalysisPerCodeline: perCodeline }],
    }));
    const r = spawnSync('bash', ['-c', `SCRIPT_DIR=${JSON.stringify(join(ORCH, 'scripts'))}; source ${JSON.stringify(join(ORCH, 'scripts/lib/review-criteria.sh'))}; review_vc_block S-1 ${JSON.stringify(prd)}`], { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath } });
    expect(r.stdout, r.stderr).toContain('VERIFICATION CRITERIA');
    return r.stdout;
  }
  it('a shared finding (this lane or a sibling) reaches the reviewers with the rule and no absolute path', () => {
    const t = reviewBlock({ site: [sharedFinding], lib: [] }, 'rev-shared');
    expect(t).toContain('@scope/lib');
    expect(t).toContain('SHARED WITH OTHER CODELINES');
    expect(t).toContain('../lib-repo');
    expect(t).not.toContain('/w/codelines');
  });
  it('nothing shared: the block is exactly the criteria, as before', () => {
    const t = reviewBlock({ site: [plainFinding], lib: [] }, 'rev-plain');
    expect(t).not.toContain('SHARED WITH');
    expect(t.trim()).toBe('VERIFICATION CRITERIA (the observable checks this change MUST satisfy — judge the diff against every one):\n- the toast is announced');
  });
});

describe('the words are in the template layer and name no project', () => {
  for (const id of ['spec-shared-consumer', 'review-shared']) {
    it(`${id} names none of the projects`, () => {
      const raw = readFileSync(join(ORCH, 'prompts/templates', `${id}.json`), 'utf8').toLowerCase();
      const projects = readdirSync(join(ORCH, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      expect(projects.length).toBeGreaterThan(0);
      for (const n of projects) expect(raw).not.toContain(n.toLowerCase());
    });
  }
});
