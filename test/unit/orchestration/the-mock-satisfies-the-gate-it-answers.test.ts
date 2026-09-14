/**
 * THE STAND-IN MUST PASS THE GATE THE REAL AGENT PASSES.
 *
 * The free rehearsal exists so the mint can be exercised without paying. That only holds if the
 * mock's own answer satisfies the mint's contract — and four times running it did not, each one
 * reading in the log exactly like a pipeline defect:
 *
 *   1. `kind` filled with prose, so the mint refused "unrecognised kind"
 *   2. `name` filled with prose containing spaces — "not a plain kebab-case identifier"
 *   3. `rationale` 19 characters against a declared minimum of 24 — "says nothing"
 *   4. the name suffixed after the seam, routing nowhere — "resolves to no seam"
 *
 * Each cost a rehearsal to find. All four are one assertion: put the stand-in through
 * isUsableProposal — the mint's own gate, not a copy of it — and the harness can never again
 * fail the run it was built to make free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';

// A TEST MUST NOT DEPEND ON THE SHELL THAT LAUNCHED IT. This passed only when the caller happened
// to export PRD_FILE; without it projectStories() is empty, every per-story stand-in loses its
// story, and the assertion fails for a reason that has nothing to do with what it tests. The
// project is DISCOVERED — the first one declaring stories — so no path is written down here.
//
// The AUTHORED PRD, not the runtime one: prd.json is what a run restores from prd.authored.json
// (pre-run-reset) or from PRD_CANONICAL (greenfield), and it is not tracked — a checkout may hold
// none at all, which left this test red for a reason that had nothing to do with what it tests.
const ROOT = path.join(__dirname, '../../../');
const PROJECTS = path.join(ROOT, 'orchestrations/projects');
const withStories = fs.readdirSync(PROJECTS)
  .flatMap((d) => {
    const out = [path.join(PROJECTS, d, 'prd.authored.json')];
    try {
      const m = fs.readFileSync(path.join(PROJECTS, d, 'config.env'), 'utf8').match(/^PRD_CANONICAL=(.+)$/m);
      if (m) out.push(path.isAbsolute(m[1].trim()) ? m[1].trim() : path.join(ROOT, m[1].trim()));
    } catch { /* a project with no config declares no canonical */ }
    return out;
  })
  .find((f) => {
    try { return (JSON.parse(fs.readFileSync(f, 'utf8')).stories || []).length > 0; } catch { return false; }
  });
if (withStories) process.env.PRD_FILE = withStories;

const mock = require('../../../orchestrations/scripts/mock-expectations.js');
const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

describe('the mock satisfies the gate it answers', () => {
  it('the mint stand-in passes the mint\'s own usability gate', () => {
    const standIn = mock.contractStandIn('agent-mint');
    expect(standIn, 'the harness must produce a mint answer at all').toBeTruthy();

    const proposals = Array.isArray(standIn) ? standIn
      : (standIn.agents || standIn.projectAgents || [standIn]);
    expect(proposals.length, 'a stand-in proposing nothing proves nothing').toBeGreaterThan(0);

    for (const p of proposals) {
      // isUsableProposal returns a REASON when it refuses, and null when it accepts.
      expect(roster.isUsableProposal(p), `the mint refused its own stand-in: ${p && p.name}`)
        .toBeFalsy();
    }
  });

  it('a role-valued field is recognised however the contract words it', () => {
    // The property that broke this was worded in the plural — the one property the function
    // exists to recognise was the one its regex missed.
    expect(mock.expectsARole({ description: 'MUST be one of the offered roles, verbatim.' })).toBe(true);
    expect(mock.expectsARole({ description: 'The role that owns this story.' })).toBe(true);
    expect(mock.expectsARole({ description: 'One sentence: why this owns this story.' })).toBe(false);
  });

  it('the name the mint registers is the name the assigner offers', () => {
    // Two stand-ins, one registry: the assigner cannot offer a role the mint never minted.
    const minted = mock.standInRoleName('implementer');
    expect(minted, 'no implementer name routes — the registry declares one').toBeTruthy();
    expect(minted).toMatch(roster.ROLE_NAME_RE);
    expect(roster.isUsableProposal({
      name: minted, kind: 'implementer', systemPrompt: 'x', rationale: 'y'.repeat(40),
      codeline: '*',
    }), `the minted implementer name is not usable: ${minted}`).toBeFalsy();
  });

  it('the assigner offers exactly the role the mint mints', () => {
    // Not "a role of the right kind" — THE role. Expectations are registered before the run, so
    // the roster is empty on disk and any independently-derived name is a guess. Both stand-ins
    // read the one answer, so they cannot disagree.
    const mint = mock.contractStandIn('agent-mint');
    const minted = (Array.isArray(mint) ? mint : (mint.agents || [mint])).map((a: any) => a.name);
    expect(minted.length, 'the mint must mint something for this to mean anything').toBeGreaterThan(0);

    const assigned = mock.contractStandIn('role-assigner');
    const rows = Array.isArray(assigned) ? assigned : [assigned];
    expect(rows.length, 'the assigner must answer for at least one story').toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.storyId, 'an assignment that names no story answers for none').toBeTruthy();
      expect(minted, `story ${row.storyId} was assigned a role the mint never minted`)
        .toContain(row.agentRole);
    }
  });
});

/**
 * A VERDICT SEAM'S STAND-IN SPEAKS THE VOCABULARY ITS JUDGE DECLARES.
 *
 * The verdict stand-in answered `pass` for every verdict-kind seam. Both roster reviews are judged
 * against TOOL_ROSTER_REVIEW, whose enum is sound | defects_found | nothing_to_review — so the
 * stand-in was refused ("does not allow — declared values are…"), read as a review that did not
 * look, retried three times identically, and the mint aborted. Found 2026-09-13 by the £0
 * greenfield integration test, one stage past the sizing defect it had just uncovered.
 *
 * The contract now names the tag a verdict is judged under; the stand-in reads the vocabulary
 * from that tag's live tool definition and is put through the same validator the pipeline uses.
 */
describe('a verdict stand-in satisfies the validator its seam is judged by', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const contracts = schema.declaredContracts() as Record<string, any>;
  const tagged = Object.entries(contracts).filter(([, c]) => c.kind === 'verdict' && c.tag);

  it('the roster reviews declare the tag they are judged under', () => {
    for (const seam of ['roster-review', 'project-roster-review']) {
      expect(contracts[seam] && contracts[seam].tag, `${seam} declares no tag`).toBeTruthy();
    }
  });

  for (const [seam, c] of tagged) {
    it(`${seam}: the stand-in passes validateTaggedOutput for <${c.tag}>`, () => {
      const standIn = mock.contractStandIn(seam);
      expect(standIn, 'no stand-in').toBeTruthy();
      const r = schema.validateTaggedOutput(c.tag, standIn);
      expect(r.ok, r.reason).toBe(true);
    });
  }
});

/**
 * THE DISCOVERY STAND-IN NAMES THE REPOSITORIES THIS RUN ACTUALLY HAS.
 *
 * codeline-discovery's parse refuses an answer that selects no codeline, or one whose path is not
 * an existing git repository. The declared stand-in filled `codelines` with [] (a plural key is a
 * list), and the only recording of the seam came from another estate, whose paths do not exist
 * here — so the £0 brownfield run was refused three times at its first model stage (2026-09-13).
 * The repositories a tracker run scopes are the ones under JIRA_CODELINE_ROOT — the run's own
 * declaration — so the stand-in selects exactly those, with their real absolute paths.
 */
describe('the discovery stand-in names the repositories this run has', () => {
  const { mkdtempSync, mkdirSync, existsSync: exists } = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  it('selects every git repository under JIRA_CODELINE_ROOT, by real absolute path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cl-root-'));
    for (const n of ['alpha', 'beta']) { mkdirSync(path.join(root, n)); execFileSync('git', ['-C', path.join(root, n), 'init', '-q']); }
    mkdirSync(path.join(root, 'not-a-repo'));
    const prev = process.env.JIRA_CODELINE_ROOT; process.env.JIRA_CODELINE_ROOT = root;
    try {
      const standIn = mock.contractStandIn('codeline-discovery');
      const picked = (standIn && standIn.codelines) || [];
      expect(picked.map((c: any) => c.name).sort()).toEqual(['alpha', 'beta']);
      for (const c of picked) {
        expect(path.isAbsolute(c.path)).toBe(true);
        expect(exists(path.join(c.path, '.git')), `${c.path} is not a git repository`).toBe(true);
      }
    } finally { if (prev === undefined) delete process.env.JIRA_CODELINE_ROOT; else process.env.JIRA_CODELINE_ROOT = prev; }
  });
  it('with no codeline root declared, the list stays empty — nothing is invented', () => {
    const prev = process.env.JIRA_CODELINE_ROOT; delete process.env.JIRA_CODELINE_ROOT;
    try { expect((mock.contractStandIn('codeline-discovery') || {}).codelines).toEqual([]); }
    finally { if (prev !== undefined) process.env.JIRA_CODELINE_ROOT = prev; }
  });
});

/**
 * A TRACKER RUN'S STORIES COME FROM THE TRACKER — before the PRD exists.
 *
 * Under JIRA_PIPELINE=1 the PRD is synthesised during the run, after the AC gate has already
 * called a model, so registration keyed on a PRD had nothing to key on and refused. The stand-ins
 * now ask the same fetcher the ingest uses, and register a ticket under every id the AC gate may
 * give it: its own key (a spanning story) and `<key>-<codeline>` for each repository in the estate
 * (a split story). Driven through the real stub tracker and the real fetcher.
 */
describe("a tracker run's stories come from the tracker", () => {
  const { spawn } = require('node:child_process');
  const { mkdtempSync, mkdirSync, readFileSync: rf, existsSync: ex } = require('node:fs');
  const { execFileSync: exec } = require('node:child_process');
  const os = require('node:os');
  let jira: any; let port = '';
  beforeAll(async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'jira-')), 'jira.out');
    jira = spawn(process.execPath, [path.join(ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js'), 'TRK-7', 'a summary', 'a description'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the stub tracker never reported a port')), 15_000);
      jira.stdout.on('data', (d: Buffer) => { buf += d; const m = buf.match(/LISTENING:(\d+)/); if (m) { port = m[1]; clearTimeout(t); resolve(); } });
    });
    void out; void rf; void ex;
  }, 20_000);
  afterAll(() => { try { jira.kill('SIGKILL'); } catch { /* gone */ } });

  it('registers the ticket under its key and under <key>-<codeline> for every estate repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'estate-'));
    mkdirSync(path.join(root, 'hello-svc')); exec('git', ['-C', path.join(root, 'hello-svc'), 'init', '-q']);
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string | undefined) => { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    set('JIRA_PIPELINE', '1'); set('JIRA_URL', `http://127.0.0.1:${port}`); set('JIRA_EMAIL', 'mock@test.com'); set('JIRA_TOKEN', 'mock-token');
    set('JIRA_PROJECT_KEY', 'TRK'); set('JIRA_STATUS_FILTER', 'To Do'); set('JIRA_CODELINE_ROOT', root); set('PRD_FILE', path.join(root, 'no-prd.json'));
    try {
      // Every module-level cache is per process: a fresh require sees this environment.
      delete require.cache[require.resolve('../../../orchestrations/scripts/mock-expectations.js')];
      const fresh = require('../../../orchestrations/scripts/mock-expectations.js');
      const rows = fresh.contractStandIn('role-assigner');
      const ids = (Array.isArray(rows) ? rows : [rows]).map((r: any) => r.storyId).sort();
      const { deriveCodelineName } = require('../../../orchestrations/scripts/lib/codeline-name.js');
      expect(ids).toEqual(['TRK-7', `TRK-7-${deriveCodelineName('hello-svc')}`].sort());
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
});

/**
 * THE SPECIALISER STAND-IN ANSWERS AS THE MODEL DID: IT ADDS THE MINTED AGENTS.
 *
 * Run 5 (2026-09-13, $0.34) wrote "0 specialised, 2 added" and the engine refused both minted
 * agents for a digest it had not computed. The stand-in had always written an empty delta, so the
 * £0 test never reached that path. The stand-in now adds every agent the mint stand-in mints, each
 * its own ancestor — and the delta is put through the engine's own compose and contract check.
 */
describe('the specialiser stand-in adds the minted agents and the engine accepts them', () => {
  it('composes through composeFromDelta and passes checkRoster', () => {
    const { mkdtempSync: mk, writeFileSync: wf } = require('node:fs');
    const os = require('node:os');
    const rosterLib = require('../../../orchestrations/scripts/lib/project-roster.js');
    const delta = mock.contractStandIn('roster-specialiser');
    const names = Object.keys((delta && delta.agents) || {});
    expect(names.length, 'the stand-in delta adds nothing — it does not answer as a model does').toBeGreaterThan(0);
    for (const n of names) expect(delta.agents[n].ancestor, `${n} is not its own ancestor`).toBe(n);
    // The mint registers what it minted before the specialiser runs; the fixture does the same.
    const d = mk(path.join(os.tmpdir(), 'stand-in-delta-'));
    const byKind: Record<string, string[]> = {};
    for (const n of names) (byKind[delta.agents[n].kind || 'implementer'] ||= []).push(n);
    wf(path.join(d, 'project-roles.json'), JSON.stringify({ roles: byKind.implementer || [] }));
    wf(path.join(d, 'project-investigators.json'), JSON.stringify({ investigators: byKind.investigator || [] }));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = d;
    try {
      const canon = { 'team-lead-review': 'a canonical persona' };
      const { roster: r, added } = rosterLib.composeFromDelta(delta, canon);
      expect(added).toBe(names.length);
      const check = rosterLib.checkRoster(r, canon);
      expect(check.ok, `the engine refused the stand-in delta: ${check.reason}`).toBe(true);
    } finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; }
  });
});

/**
 * AN UNTAGGED VERDICT STAND-IN PASSES THE GATE VERDICT SCHEMA — the validator the contract names
 * for that kind (lib/gate_verdict_schema.py). Every QA gate refused the bare {verdict, findings}
 * for want of a summary, twice, and the testing gates failed (£0 greenfield harness, 2026-09-13).
 */
describe('an untagged verdict stand-in passes the gate verdict schema', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const { spawnSync } = require('node:child_process');
  const contracts = schema.declaredContracts() as Record<string, any>;
  const untagged = Object.entries(contracts).filter(([, c]) => c.kind === 'verdict' && !c.tag).map(([s]) => s);
  it('there are untagged verdict seams to check', () => { expect(untagged.length).toBeGreaterThan(0); });
  it.each(untagged)('%s: the stand-in is accepted by gate_verdict_schema.validate', (seam) => {
    const standIn = mock.contractStandIn(seam);
    const r = spawnSync('python3', ['-c', `
import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'orchestrations/scripts/lib'))})
from gate_verdict_schema import validate
ok, why = validate(sys.argv[1], sys.argv[2]); print('OK' if ok else 'NO ' + str(why))`, seam, JSON.stringify(standIn)], { encoding: 'utf8' });
    expect((r.stdout || '').trim(), r.stderr).toBe('OK');
  });
});

/**
 * THE GUARD'S STAND-IN ARMS THE GUARD. The vocabulary seam's consumer refuses an empty blacklist
 * ("a guard with no vocabulary checks nothing") and aborts the spec pass; its tool schema declared
 * no minimum, so the stand-in built from that schema answered `blacklist: []` and the £0 greenfield
 * harness died at the first story (run 19, 2026-09-14). The contract states the minimum the
 * consumer enforces; the stand-in is read from the contract; the consumer is the judge.
 */
describe('the vocabulary stand-in arms the guard that consumes it', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const guard = require('../../../orchestrations/scripts/lib/guard-vocabulary.js');
  // The seam is the one whose contract is bound to the guard tool — never named here.
  const contracts = schema.declaredContracts() as Record<string, any>;
  const seams = Object.entries(contracts)
    .filter(([, c]) => c.kind === 'schema' && c.tag && schema.itemSchemaFor(c.tag) === guard.TOOL_GUARD_VOCABULARY.parameters)
    .map(([s]) => s);
  it('exactly one seam is bound to the guard vocabulary tool', () => { expect(seams).toHaveLength(1); });
  it('the tool declares the minimum its consumer enforces', () => {
    expect(guard.TOOL_GUARD_VOCABULARY.parameters.properties.blacklist.minItems).toBeGreaterThanOrEqual(1);
  });
  it.each(seams)('%s: the stand-in is usable by isVocabularyUsable after normalisation', (seam) => {
    const standIn = mock.contractStandIn(seam);
    expect(standIn).toBeTruthy();
    const v = guard.normaliseVocabulary(standIn);
    expect(guard.isVocabularyUsable(v), JSON.stringify(standIn)).toBe(true);
  });
});

/**
 * THE PROMPT REVIEWER READS THE STAND-IN AS A REVIEW THAT RAN. The reviewer reads its verdict out
 * of a `<PROMPT_REVIEW>` block (lib/prompt-review.js) and installs the prompt UNREVIEWED when the
 * block is absent; the contract said "verdict", the stand-in was bare JSON, and every prompt of
 * the £0 greenfield harness was installed unreviewed (run 19, 2026-09-14) — a gate failing open
 * behind a stand-in. The contract now declares the tag the consumer reads; the mock delivers every
 * tagged contract as its tag; the consumer is the judge.
 */
describe('the prompt reviewer reads the stand-in as a review that ran', () => {
  const { makePromptReviewer } = require('../../../orchestrations/scripts/lib/prompt-review.js');
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  // The seam is the one whose prompt the reviewer renders — its own id, read from the library.
  const seam = 'prompt-review';
  it('the contract declares the tag the reviewer reads', () => {
    const c = (schema.declaredContracts() as Record<string, any>)[seam];
    expect(c && c.tag, JSON.stringify(c)).toBeTruthy();
  });
  it('the delivered stand-in is a review that RAN, not UNREVIEWED', async () => {
    const text = mock.standInReplyText(seam);
    expect(text, 'no stand-in text for the reviewer').toBeTruthy();
    const warnings: string[] = [];
    const review = makePromptReviewer({
      render: () => 'REVIEW', invoke: async () => text, values: () => ({}),
      warn: (m: string) => warnings.push(m), projectConfigDir: '/proj',
    });
    const out = await review({ id: 'x', template: { body: 'g' }, generated: { body: 's' } });
    expect(out.ok).toBe(true);
    expect(warnings.join('\n')).not.toMatch(/UNREVIEWED/);
  });
});

/**
 * A DECLARED SHAPE WINS OVER THE KEY'S NAME. `diagnosis` ends in an s and is one diagnosis; the
 * stand-in read it as a list and every healing event of the £0 harness recorded "[]" as its
 * diagnosis (2026-09-14). A contract states a shape where the name misleads; the stand-in obeys it.
 */
describe('a declared key shape wins over what the key name suggests', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const shaped = Object.entries(schema.declaredContracts() as Record<string, any>).filter(([, c]) => c.kind === 'declared' && c.shapes);
  it('some contract declares shapes', () => { expect(shaped.length).toBeGreaterThan(0); });
  it.each(shaped.map(([s]) => s))('%s: every declared shape is honoured by the stand-in', (seam) => {
    const c = (schema.declaredContracts() as Record<string, any>)[seam];
    const standIn = mock.contractStandIn(seam);
    for (const [k, shape] of Object.entries(c.shapes as Record<string, any>)) {
      if (!(k in standIn)) continue;
      const v = standIn[k];
      const actual = Array.isArray(v) ? 'array' : typeof v;
      // An object-valued shape points at a schema (an object built from it) or at the codeline (a
      // repo-relative file path, a string).
      expect(actual, `${seam}.${k}`).toBe(typeof shape === 'object' ? (shape.fromCodeline ? 'string' : 'object') : shape);
      if (shape === 'string') expect(String(v).trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * A CONTRACT THAT ASKS FOR THE PROMPT'S EXEMPLAR GETS THE WHOLE ANSWER THE PROMPT STATES. The
 * failure analyst's `target: prd` with one `ac_patches` entry is what reaches the change reviewer
 * and, on a rejection, the summarizer; with `diagnosis` alone neither ever ran at £0 (2026-09-14).
 */
describe('a declared contract that asks for the prompt exemplar carries every key the prompt states', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const asking = Object.entries(schema.declaredContracts() as Record<string, any>).filter(([, c]) => c.kind === 'declared' && c.exemplarFromPrompt).map(([s]) => s);
  it('some contract asks for it', () => { expect(asking.length).toBeGreaterThan(0); });
  it.each(asking)('%s: every known key is present, lists carry one shaped item, choices are one member', (seam) => {
    const c = (schema.declaredContracts() as Record<string, any>)[seam];
    const standIn = mock.contractStandIn(seam);
    for (const k of c.knownKeys) expect(standIn, `${seam}.${k}`).toHaveProperty(k);
    for (const [k, v] of Object.entries(standIn)) {
      if (Array.isArray(v)) { expect(v.length, `${seam}.${k} carries an item`).toBeGreaterThan(0); }
      if (typeof v === 'string') expect(v, `${seam}.${k} is one member, not a|b|c`).not.toMatch(/\|/);
    }
  });
});

/** A DECLARED PREFERENCE is honoured: the contract says which branch of the consumer the rehearsal takes. */
describe('a declared preference among the values the prompt offers is honoured', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const preferring = Object.entries(schema.declaredContracts() as Record<string, any>).filter(([, c]) => c.prefer);
  it('some contract prefers', () => { expect(preferring.length).toBeGreaterThan(0); });
  it.each(preferring.map(([s]) => s))('%s: the stand-in carries the preferred value', (seam) => {
    const c = (schema.declaredContracts() as Record<string, any>)[seam];
    const standIn = mock.contractStandIn(seam);
    for (const [k, v] of Object.entries(c.prefer)) expect(standIn[k], `${seam}.${k}`).toBe(v);
  });
});

/** A VALUE OVER A DECLARED LIMIT is built from the limit the config declares, never a number typed in the mock. */
describe('a value the contract says must exceed a declared limit does, by the config that declares it', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const over = Object.entries(schema.declaredContracts() as Record<string, any>).filter(([, c]) => c.overDeclaredLimit);
  it('some contract declares one', () => { expect(over.length).toBeGreaterThan(0); });
  it.each(over.map(([s]) => s))('%s: the value is longer than the declared limit', (seam) => {
    const c = (schema.declaredContracts() as Record<string, any>)[seam];
    const standIn = mock.contractStandIn(seam);
    for (const [k, ref] of Object.entries(c.overDeclaredLimit as Record<string, string>)) {
      const [file, dotPath] = ref.split('#');
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'orchestrations', file), 'utf8'));
      const limit = Number(dotPath.split('.').reduce((a: any, kk: string) => a && a[kk], cfg));
      expect(limit).toBeGreaterThan(0);
      expect(String(standIn[k]).length, `${seam}.${k}`).toBeGreaterThan(limit);
    }
  });
});

/**
 * THE SYNTHESIZER'S STAND-IN IS ADMISSIBLE. Wrapped exactly as lib/kb-synthesizer.js wraps a
 * proposal, the constraint must pass the store's own validator (lib/kb_schema.py) — a {note}
 * answer was rejected fifteen times by the runner and recorded no_output (run 29, 2026-09-14).
 */
describe("the synthesizer's stand-in is a constraint the KB store admits", () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const seams = Object.entries(schema.declaredContracts() as Record<string, any>)
    .filter(([, c]) => c.shapes && Object.values(c.shapes).some((v: any) => v && typeof v === 'object' && v.schemaCommand)).map(([s]) => s);
  it('a contract points at a schema command', () => { expect(seams.length).toBeGreaterThan(0); });
  it.each(seams)('%s: the wrapped proposal validates as a constraint', (seam) => {
    const standIn = mock.contractStandIn(seam);
    const candidate = { id: 'stand-in-role-class-x', scope: { agent_role: 'stand-in-role' }, trigger: { signature: 'class:x' },
      enforcement: standIn.enforcement, reason: String(standIn.reason).slice(0, 300), origin_episodes: ['evt-1'] };
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('python3', [path.join(ROOT, 'orchestrations/scripts/lib/kb_schema.py'), 'validate-constraint'], { input: JSON.stringify(candidate), encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
