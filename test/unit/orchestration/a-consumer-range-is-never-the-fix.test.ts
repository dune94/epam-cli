/**
 * A CONSUMER'S DECLARED RANGE IS NEVER THE FIX — THE PROVIDER SHIPS INSIDE IT.
 *
 * Operator, 2026-10-06 (AMSD-2974: a shared library whose fix ships a major version past two
 * consumers' ranges): "You have to avoid package.json upgrades in this change", "the up and metrolinx
 * package may be locked at this shared level for a reason", "You have to increment 7.x shared do you
 * not?". All four shared blocks told agents to bump a consumer's manifest; the specs of two lanes
 * named package.json as their only fix site. The rule now: a consumer's range is fixed, and the
 * provider ships the change on a release line inside each range.
 *
 * EXECUTED: each block is rendered by the code that renders it in a run — detectivePrescription,
 * the fix-plan producer, runSpecAgent (stand-in runner records the prompt), review_vc_block.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ORCH = join(__dirname, '../../../orchestrations');
const work = mkdtempSync(join(tmpdir(), 'consumer-range-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

process.env.SPEC_MODE_NO_MAIN = '1';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(ORCH, 'scripts/spec-mode-runner.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixPlan = require(join(ORCH, 'scripts/lib/producers/fix-plan.js'));

const shared = {
  package: '@scope/lib', providedBy: 'lib', shipsInVersion: '8.1.0',
  consumers: [{ codeline: 'site', declaredRange: '^7', receivesChange: false }], note: '',
};
const libFinding = { codeline: 'lib', file: 'src/toast.tsx', function: 'Toast', reason: 'r', fix: 'f', changeRequired: true, shared };
const siteFinding = { codeline: 'site', file: 'src/page.tsx', function: 'Page', reason: 'r2', fix: 'f2', changeRequired: true, shared };
const spanning = (lane: string) => ({
  id: 'S-1', title: 't', description: 'd', codeline: lane, codelines: ['lib', 'site'], acceptanceCriteria: [],
  verificationCriteria: ['the toast is announced'],
  fixSiteAnalysis: lane === 'lib' ? [libFinding] : [siteFinding],
  fixSiteAnalysisPerCodeline: { lib: [libFinding], site: [siteFinding] },
});
const prdFor = (lane: string) => ({
  project: {
    outputDir: lane === 'lib' ? '/w/codelines/lib-repo' : '/w/codelines/site.example',
    outputDirs: [{ codeline: 'lib', path: '/w/codelines/lib-repo' }, { codeline: 'site', path: '/w/codelines/site.example' }],
  },
  stories: [spanning(lane)],
});

// Each block: what it must now say, and the consumer-bump instruction it must no longer give.
const RULES = {
  detective: {
    says: [/declared range of a shared package is NEVER changed by this story/, /Never name a consumer's manifest entry as a fix site/, /release line inside that consumer's range/],
    never: [/the manifest entry that must change/, /never describe that consumer as needing no edit/],
  },
  fixPlan: {
    says: [/Never edit a consumer's declared range of a shared package/, /release line inside that range/, /range that consumer ALREADY declares/],
    never: [/manifest entry is part of this codeline's change and must be edited/],
  },
  spec: {
    says: [/its declared range is never part of this codeline's change/, /from a release its declared range already takes/],
    never: [/the dependency entry is part of this codeline's change/],
  },
  review: {
    says: [/declared range of a shared package is a BLOCKER finding/, /through the range it ALREADY declares/],
    never: [/editing that manifest entry is required/, /not a thin change/],
  },
};
function judge(text: string, rule: { says: RegExp[]; never: RegExp[] }) {
  expect(text.length, 'nothing rendered').toBeGreaterThan(200);
  for (const re of rule.says) expect(text).toMatch(re);
  for (const re of rule.never) expect(text).not.toMatch(re);
}

describe('the detective is told a consumer range is fixed and the remedy is in the provider', () => {
  for (const kind of ['defect', 'novel']) {
    for (const lane of ['lib', 'site']) {
      it(`${kind}, ${lane} lane`, () => {
        const out = runner.detectivePrescription(kind, spanning(lane));
        expect(out).toContain('"shared"');
        judge(out, RULES.detective);
      });
    }
  }
});

describe('the writer is told never to edit a consumer range', () => {
  for (const lane of ['lib', 'site']) {
    it(`${lane} lane`, () => {
      const text = fixPlan.renderStoryPlan(spanning(lane), prdFor(lane));
      expect(text).toContain('@scope/lib');
      judge(text, RULES.fixPlan);
    });
  }
});

describe('the spec agent is told a consumer range is not part of the change', () => {
  it('a shared, out-of-range finding', async () => {
    const proj = join(work, 'project');
    mkdirSync(join(proj, 'prompts'), { recursive: true });
    for (const f of readdirSync(join(ORCH, 'prompts/templates')).filter((n) => n.startsWith('spec-agent-openspec'))) {
      copyFileSync(join(ORCH, 'prompts/templates', f), join(proj, 'prompts', f));
    }
    const out = join(work, 'spec.txt');
    const sh = join(work, 'runner.sh');
    writeFileSync(sh, `#!/bin/bash\n{ echo "ARGS: $*"; cat; } >> ${JSON.stringify(out)}\n`);
    chmodSync(sh, 0o755);
    process.env.EPAM_PROJECT_CONFIG_DIR = proj;
    process.env.EPAM_BROWNFIELD = '1';
    const logDir = join(work, 'logs-spec'); mkdirSync(logDir, { recursive: true });
    const story = spanning('site');
    await runner.runSpecAgent({
      promptExec: { cmd: sh, args: [] }, agent: 'openspec', story, phase: 'core', runId: 'R', logDir,
      prd: { stories: [story], project: { outputDir: work, outputDirs: [] } },
      runDetective: async () => [siteFinding],
    });
    expect(existsSync(out), 'the runner was never asked').toBe(true);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('SHARED WITH ANOTHER CODELINE');
    judge(text, RULES.spec);
  }, 120000);
});

describe('both diff reviewers treat a consumer range change as a blocker', () => {
  for (const lane of ['lib', 'site']) {
    it(`${lane} lane`, () => {
      const prd = join(work, `rev-${lane}.json`);
      writeFileSync(prd, JSON.stringify(prdFor(lane)));
      const r = spawnSync('bash', ['-c', `SCRIPT_DIR=${JSON.stringify(join(ORCH, 'scripts'))}; source ${JSON.stringify(join(ORCH, 'scripts/lib/review-criteria.sh'))}; review_vc_block S-1 ${JSON.stringify(prd)}`], { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath } });
      expect(r.stdout, r.stderr).toContain('SHARED WITH OTHER CODELINES');
      judge(r.stdout, RULES.review);
    });
  }
});
