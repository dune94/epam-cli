/**
 * A SHARED FIX SITE REACHES THE WRITER — AS THE DETECTIVE'S OWN FINDING, NOT AS ENGINE RULES.
 *
 * Operator, 2026-10-01 (AMSD-2974: a shared library and three sites that consume it): "shared changes
 * MUST be treated differently", "we have to mirror what the human dev faces", "100% agentic — no
 * gates/guards deterministic code", and "Can detective not return a shared attribute when diagnosing
 * the codelines?". The spec said the sites needed no edit because their declared range "picks it up";
 * the library's master is a major version past every site's range, so it does not. A developer
 * points each site at the library's working copy to build and test, and saves none of that.
 *
 * So: the detective of a story that spans codelines is asked whether a fix site is shared, the answer
 * survives the parse, and the writer's plan carries it — with the sibling's working copy named by a
 * RELATIVE location. A story confined to one codeline sees none of it, byte for byte.
 *
 * EXECUTED: the real detectivePrescription and parseDetectiveFindings (spec-mode-runner.js), and the
 * real fix-plan producer (lib/producers/fix-plan.js), as the lane's PRD carries the story.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(ORCH, 'scripts/spec-mode-runner.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixPlan = require(join(ORCH, 'scripts/lib/producers/fix-plan.js'));

const shared = {
  package: '@scope/lib', providedBy: 'lib',
  consumers: [{ codeline: 'site', declaredRange: '^7', receivesChange: false }],
  note: 'the change ships in 8.x; ^7 never takes it',
};
const libFinding = { codeline: 'lib', file: 'src/toast.tsx', function: 'Toast', reason: 'r', fix: 'f', changeRequired: true, shared };
const siteFinding = { codeline: 'site', file: 'src/page.tsx', function: 'Page', reason: 'r2', fix: 'f2', changeRequired: true };

const spanning = (lane: string) => ({
  id: 'S-1', codeline: lane, codelines: ['lib', 'site'],
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

describe('the detective of a spanning story is asked whether a fix site is shared', () => {
  const single = { id: 'S-2', codeline: 'lib', fixSiteAnalysis: [] };

  for (const kind of ['defect', 'novel']) {
    it(`${kind}: a spanning story's instructions ask for "shared" and name the other codelines`, () => {
      const out = runner.detectivePrescription(kind, spanning('site'));
      expect(out.length).toBeGreaterThan(runner.detectivePrescription(kind).length);
      expect(out).toContain('"shared"');
      expect(out).toMatch(/\blib\b/);
    });

    it(`${kind}: a sibling's shared finding is handed over as a lead`, () => {
      const out = runner.detectivePrescription(kind, spanning('site'));
      expect(out).toContain('@scope/lib');
      expect(out).toContain('src/toast.tsx');
    });

    it(`${kind}: a story confined to one codeline gets today's instructions, byte for byte`, () => {
      const base = runner.detectivePrescription(kind);
      expect(base.length, 'the prescription rendered nothing').toBeGreaterThan(100);
      expect(runner.detectivePrescription(kind, single)).toBe(base);
      expect(base).not.toContain('"shared"');
    });
  }

  it('the lane never hands a finding of its own back to itself as a sibling lead', () => {
    const out = runner.detectivePrescription('novel', spanning('lib'));
    expect(out).not.toContain('src/toast.tsx');
  });
});

describe('the shared answer survives the parse', () => {
  it('kept when given, absent when not', () => {
    const reply = JSON.stringify([
      { file: 'src/a.ts', reason: 'r', fix: 'f', changeRequired: true, shared },
      { file: 'src/b.ts', reason: 'r', fix: 'f', changeRequired: true },
    ]);
    const [a, b] = runner.parseDetectiveFindings(reply, '');
    expect(a.shared).toEqual(shared);
    expect(b.shared).toBeUndefined();
  });

  it('a malformed shared answer is not invented into one', () => {
    const [a] = runner.parseDetectiveFindings(JSON.stringify([{ file: 'src/a.ts', shared: 'yes' }]), '');
    expect(a.shared).toBeUndefined();
  });

});

describe('the writer\'s plan carries the shared fact', () => {
  it('the consuming lane\'s writer is told the change lives in a sibling, where its working copy is, and that its range does not take it', () => {
    const text = fixPlan.renderStoryPlan(spanning('site'), prdFor('site'));
    expect(text).toContain('src/page.tsx');
    expect(text).toContain('@scope/lib');
    expect(text).toContain('../lib-repo');
    expect(text).toContain('^7');
    expect(text, 'an absolute path reached the writer').not.toContain('/w/codelines');
  });

  it('the providing lane\'s own site renders its shared fact', () => {
    const text = fixPlan.renderStoryPlan(spanning('lib'), prdFor('lib'));
    expect(text).toContain('src/toast.tsx');
    expect(text).toContain('@scope/lib');
    expect(text).toMatch(/\bsite\b/);
    expect(text).not.toContain('/w/codelines');
  });

  it('a story with nothing shared renders exactly what it rendered before', () => {
    const story = { ...spanning('site'), fixSiteAnalysisPerCodeline: { lib: [{ ...libFinding, shared: undefined }], site: [siteFinding] } };
    const text = fixPlan.renderStoryPlan(story, prdFor('site'));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toBe(fixPlan.renderFixPlan([siteFinding]));
  });

  it('publication uses the same rendering', () => {
    const published: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const agentIo = require(join(ORCH, 'scripts/lib/agent-io.js'));
    const orig = agentIo.publish;
    agentIo.publish = (_p: string, _k: string, id: string, text: string) => { published[id] = text; };
    try { fixPlan.publishFixPlans(prdFor('site')); } finally { agentIo.publish = orig; }
    expect(published['S-1']).toBe(fixPlan.renderStoryPlan(spanning('site'), prdFor('site')));
  });
});

describe('the new words are in the template layer and name no project', () => {
  const projects = readdirSync(join(ORCH, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const id of ['detective-shared-package', 'fix-plan-shared']) {
    it(`${id} exists and names none of the ${projects.length} projects`, () => {
      const raw = readFileSync(join(ORCH, 'prompts/templates', `${id}.json`), 'utf8');
      expect(projects.length).toBeGreaterThan(0);
      for (const p of projects) expect(raw.toLowerCase()).not.toContain(p.toLowerCase());
    });
  }
});
