/**
 * AN ESTIMATION MANIFEST BECOMES ONE RECORD PER TICKET, AND EACH CONSUMER READS IT IN ITS OWN FRAME.
 *
 * Operator, 2026-09-28: the estimation application's per-ticket assessment informs the brownfield
 * agents (EPAM_ESTIMATION_MANIFEST). Executed: the real handler's CLI
 * (lib/handlers/estimation-manifest.js) on a fixture shaped like the application's page and its JSON
 * manifest; asserted on the record it writes and the block each consumer receives. The negatives:
 * sections the format does not declare stay out, a ticket the manifest does not hold is said aloud,
 * and a story with no record renders NOTHING — the pipeline without a manifest is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const H = join(ROOT, 'orchestrations/scripts/lib/handlers/estimation-manifest.js');
const FIX = join(ROOT, 'test/fixtures/estimation/hello-dolly');
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/estimation-assessment.json'), 'utf8'));
const CONSUMERS = Object.keys(TEMPLATE.bodies);

let d = '';
beforeAll(() => { d = mkdtempSync(join(tmpdir(), 'estimation-')); });
afterAll(() => { if (d) rmSync(d, { recursive: true, force: true }); });

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [H, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

describe('extract', () => {
  it('keeps the declared sections and each manifest\'s sizing, and nothing the format does not declare', () => {
    const out = join(d, 'rec.json');
    const r = cli(['extract', FIX, 'MOCK-HW-1', out]);
    expect(r.status, r.stderr).toBe(0);
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(rec.key).toBe('MOCK-HW-1');
    const labels = rec.sections.map((s: { label: string }) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Summary', 'Code assessment — findings in the source', 'Recommended split — scope']));
    const all = rec.sections.map((s: { text: string }) => s.text).join('\n');
    expect(all).toContain('EST-FINDING-HW-7Q hardcoded greeting | high');
    expect(all).toContain('not in 1 SP');
    // Negative: undeclared sections (process narration, the appendix) do not travel.
    expect(all).not.toMatch(/nothing was written back|story points\./i);
    expect(rec.fields['engine-estimates.json']).toMatchObject({ sp: 1, o: 1, m: 1, p: 2, confidence: 95 });
  });

  it('two manifests sizing the same ticket are kept side by side, never merged', () => {
    const two = join(d, 'two'); mkdirSync(two);
    copyFileSync(join(FIX, 'engine-estimates.json'), join(two, 'a.json'));
    writeFileSync(join(two, 'b.json'), JSON.stringify({ 'MOCK-HW-1': { sp: 3, basis: 'other view' } }));
    const out = join(d, 'two.json');
    expect(cli(['extract', two, 'MOCK-HW-1', out]).status).toBe(0);
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(rec.fields['a.json'].sp).toBe(1);
    expect(rec.fields['b.json'].sp).toBe(3);
  });

  it('a ticket the manifest does not hold is said aloud, and nothing is written', () => {
    const out = join(d, 'none.json');
    const r = cli(['extract', FIX, 'NOPE-1', out]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/holds nothing for NOPE-1/);
    expect(existsSync(out)).toBe(false);
  });

  it('a named manifest file that is not valid JSON is an error, not an empty record', () => {
    const bad = join(d, 'bad.json'); writeFileSync(bad, '{ not json');
    const r = cli(['extract', bad, 'MOCK-HW-1', join(d, 'bad-out.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not valid JSON/);
  });
});

describe('for-story', () => {
  let logs = ''; let prd = '';
  beforeAll(() => {
    logs = join(d, 'logs'); mkdirSync(join(logs, 'estimation'), { recursive: true });
    expect(cli(['extract', FIX, 'MOCK-HW-1', join(logs, 'estimation', 'MOCK-HW-1.json')]).status).toBe(0);
    prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [
      { id: 'MOCK-HW-1', jiraKey: 'MOCK-HW-1' },
      { id: 'MOCK-HW-1-a', specification: { createdFrom: 'MOCK-HW-1' } },
      { id: 'MOCK-HW-1-a-1', specification: { createdFrom: 'MOCK-HW-1-a' } },
      { id: 'OTHER-2', jiraKey: 'OTHER-2' },
    ] }));
  });

  it('every consumer receives the record in its own frame, with the scope guard', () => {
    const bodies = new Set<string>();
    for (const c of CONSUMERS) {
      const r = cli(['for-story', 'MOCK-HW-1', prd, c], { EPAM_ESTIMATION_DIR: join(logs, 'estimation') });
      expect(r.status, `${c}: ${r.stderr}`).toBe(0);
      expect(r.stdout, c).toContain('EST-FINDING-HW-7Q');
      expect(r.stdout, c).toContain('Estimation assessment for MOCK-HW-1');
      expect(r.stdout, c).toMatch(/outside the estimate/);
      bodies.add(r.stdout.split('\n').slice(0, 4).join('\n'));
    }
    expect(bodies.size, 'two consumers were framed identically').toBe(CONSUMERS.length);
  });

  it('a caller holding only the story resolves its split parent as the ticket', () => {
    const r = spawnSync(process.execPath, ['-e', `const { forStory } = require(${JSON.stringify(H)});
      process.stdout.write(forStory('MOCK-HW-1-a', { stories: [{ id: 'MOCK-HW-1-a', specification: { createdFrom: 'MOCK-HW-1' } }] }, 'code-graph-detective'));`],
      { encoding: 'utf8', env: { ...process.env, EPAM_ESTIMATION_DIR: join(logs, 'estimation') } });
    expect(r.stdout, r.stderr).toContain('EST-FINDING-HW-7Q');
  });

  it('a split child — at any depth — reads its ticket\'s record', () => {
    expect(cli(['for-story', 'MOCK-HW-1-a-1', prd, 'story-writer'], { EPAM_ESTIMATION_DIR: join(logs, 'estimation') }).stdout).toContain('EST-FINDING-HW-7Q');
  });

  it('a story with no record renders nothing — a run without a manifest is unchanged', () => {
    const r = cli(['for-story', 'OTHER-2', prd, 'story-writer'], { EPAM_ESTIMATION_DIR: join(logs, 'estimation') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // No export — a run whose manifest is gone — renders nothing, even with last run's records in
    // the log directory it kept.
    const noExport = spawnSync(process.execPath, [H, 'for-story', 'MOCK-HW-1', prd, 'story-writer'],
      { encoding: 'utf8', env: { ...process.env, EPAM_ESTIMATION_DIR: '', LOG_DIR: logs } });
    expect(noExport.status).toBe(0);
    expect(noExport.stdout).toBe('');
  });

  it('a consumer the template does not frame is refused, not rendered bare', () => {
    const r = cli(['for-story', 'MOCK-HW-1', prd, 'no-such-agent'], { EPAM_ESTIMATION_DIR: join(logs, 'estimation') });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
});
