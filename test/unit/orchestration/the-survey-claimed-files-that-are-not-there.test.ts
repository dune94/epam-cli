/**
 * THE SURVEY CLAIMED FILES A CODELINE DOES NOT HAVE, AND WROTE IT TO DISK UNCHALLENGED.
 *
 * Live 2026-08-17, run 20260817T162132Z, estate-survey.json:
 *
 *     mocka | in_scope | filesRead: ["src/fares.ts", "test/fares.test.ts"]
 *     mockb | in_scope | filesRead: ["src/fares.ts", "test/fares.test.ts"]
 *
 * mockb contains only schedule.ts. The survey read mocka's files, attributed them to both
 * codelines, and MOCK3-2 — the actual mockb defect — was never identified. Its own prompt already
 * demands "you must name AT LEAST ONE FILE you opened in it", precisely because a claim about an
 * unread repository is how an unexamined codeline reads as a clean bill of health. Nothing
 * verified the named file was in that codeline.
 *
 * The roster stage caught it downstream, refusing mockb-codebase-investigator because its brief
 * named a path that does not exist — so the run survived. But estate-survey.json still holds the
 * falsehood, and every other consumer of that file inherits it.
 *
 * A path either resolves under the codeline root or it does not. That is decidable in code, at the
 * point the claim is made, and it needs no model to adjudicate.
 *
 * IT DOWNGRADES, IT DOES NOT DELETE. An in_scope claim with no verifiable file becomes
 * not_investigated with the reason recorded — the survey's own vocabulary for "this was not really
 * looked at". Discarding the entry would lose the fact that the codeline was never examined, which
 * is the one thing a later reader most needs to know.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

let work: string;
let mocka: string;
let mockb: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'survey-'));
  mocka = join(work, 'mock-a');
  mockb = join(work, 'mock-b');
  mkdirSync(join(mocka, 'src'), { recursive: true });
  mkdirSync(join(mockb, 'src'), { recursive: true });
  writeFileSync(join(mocka, 'src', 'fares.ts'), 'export const x = 1;');
  writeFileSync(join(mockb, 'src', 'schedule.ts'), 'export const y = 1;');
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const codelines = () => [
  { name: 'mocka', path: mocka },
  { name: 'mockb', path: mockb },
];

/** The exact shape the live run produced. */
const liveSurvey = () => ({
  ran: true,
  codelines: [
    { codeline: 'mocka', state: 'in_scope', filesRead: ['src/fares.ts'], surfaces: [], evidence: 'read it' },
    { codeline: 'mockb', state: 'in_scope', filesRead: ['src/fares.ts'], surfaces: [], evidence: 'same logic' },
  ],
  recommendedInvestigators: [],
});

describe('the survey claimed files that are not there', () => {
  it('the validator is reachable', () => {
    expect(typeof spec.validateSurveyFilesRead,
      'nothing validates a survey claim at the point it is made').toBe('function');
  });

  it('DOWNGRADES a codeline whose files do not exist in it', () => {
    const out = spec.validateSurveyFilesRead(liveSurvey(), codelines());
    const b = out.codelines.find((c: any) => c.codeline === 'mockb');
    expect(b.state, 'a codeline that was never opened is still reported in_scope')
      .toBe('not_investigated');
    expect(b.filesRead, 'unverifiable paths were kept as though real').toEqual([]);
  });

  it('records WHY, naming the path — a silent downgrade is its own defect', () => {
    const out = spec.validateSurveyFilesRead(liveSurvey(), codelines());
    const b = out.codelines.find((c: any) => c.codeline === 'mockb');
    expect(b.evidence).toMatch(/src\/fares\.ts/);
    expect(b.evidence).toMatch(/does not exist|not found/i);
  });

  it('leaves a TRUTHFUL claim completely untouched', () => {
    // mocka really does have src/fares.ts. Over-correction would be worse than the defect.
    const out = spec.validateSurveyFilesRead(liveSurvey(), codelines());
    const a = out.codelines.find((c: any) => c.codeline === 'mocka');
    expect(a.state).toBe('in_scope');
    expect(a.filesRead).toEqual(['src/fares.ts']);
    expect(a.evidence).toBe('read it');
  });

  it('keeps only the real paths when a claim is partly true', () => {
    const s = liveSurvey();
    s.codelines[0].filesRead = ['src/fares.ts', 'src/nope.ts'];
    const out = spec.validateSurveyFilesRead(s, codelines());
    const a = out.codelines.find((c: any) => c.codeline === 'mocka');
    expect(a.state, 'a codeline with one real file was downgraded').toBe('in_scope');
    expect(a.filesRead).toEqual(['src/fares.ts']);
  });

  it('does not touch states that make no file claim', () => {
    // no_work_found and failed are honest answers that name nothing; validating them as though
    // they had claimed a file would turn a correct report into a defect.
    const s: any = liveSurvey();
    s.codelines = [{ codeline: 'mockb', state: 'no_work_found', filesRead: [], evidence: 'looked, nothing here' }];
    const out = spec.validateSurveyFilesRead(s, codelines());
    expect(out.codelines[0].state).toBe('no_work_found');
    expect(out.codelines[0].evidence).toBe('looked, nothing here');
  });

  it('survives a survey that did not run, and an unknown codeline', () => {
    expect(spec.validateSurveyFilesRead({ ran: false }, codelines()).ran).toBe(false);
    const s: any = liveSurvey();
    s.codelines.push({ codeline: 'ghost', state: 'in_scope', filesRead: ['a.ts'], evidence: '' });
    const out = spec.validateSurveyFilesRead(s, codelines());
    const g = out.codelines.find((c: any) => c.codeline === 'ghost');
    expect(g.state, 'a codeline nobody declared was treated as verified').toBe('not_investigated');
  });
});
