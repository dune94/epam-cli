/**
 * THE WRITER MUST BE TOLD WHICH PRESCRIBED CHANGE MAKES THE NEW VALUE EXIST.
 *
 * WRITTEN BEFORE THE FIX.
 *
 * deliveryRole was added to the detective prompt and the parser on 2026-08-12 to stop a
 * prescription describing the delivery of a value nobody obtains. It is INERT: the field is
 * asked for, parsed and stored, and then
 *
 *   - the writer's prescription rendering never mentions it  (0 occurrences in claude.sh)
 *   - the reviewer never sees it                             (0 occurrences in team-lead-review.sh)
 *   - prescriptionMissingSource() is defined, exported, and CALLED BY NOTHING
 *
 * So a detective answering deliveryRole:"produces" on the one file that fetches would change
 * nothing at all. Computed and never consulted — the same defect this pipeline keeps producing,
 * and this instance was written hours after a test asserting that shape is wrong.
 *
 * Live consequence, AMSD-2041, three attempts across two models: pageService.ts — the file that
 * owns fetching — received a two-line re-export, and getEntry / live_preview:true / setContent
 * appear ZERO times in the diff. The prescription says "pass live_preview: true through to
 * getEntry". Nothing marks that site as the one that must PRODUCE the value, so it reads as one
 * bullet among four.
 *
 * THE TEST RENDERS THE REAL jq that builds the writer's prescription block, against fix sites
 * carrying the field. Asserting the source mentions "deliveryRole" would pass on a comment.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const src = () => readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The REAL jq program claude.sh uses to render fix sites for the writer. */
function renderer(): string {
  const s = src();
  const start = s.indexOf('fix_site_analysis=$(echo "$story_json" | jq -r \'');
  expect(start, 'the fix-site renderer moved — this test is anchored on it').toBeGreaterThan(0);
  const from = s.indexOf("'", start) + 1;
  // The jq program ends at the quote FOLLOWED BY ` 2>/dev/null` — searching for "'\n" found a
  // later apostrophe and swallowed several hundred lines of the script into the "program".
  const end = s.indexOf("' 2>/dev/null", from);
  expect(end, 'the jq terminator moved').toBeGreaterThan(from);
  return s.slice(from, end);
}

function render(sites: any[]): string {
  // The program goes to a FILE and is read with `jq -f`. Passing it as a shell argument breaks
  // on the backticks and quotes inside the prompt prose it emits — the same class of hazard as
  // prompt text living in a shell string.
  const dir = mkdtempSync(join(tmpdir(), 'fixsite-render-'));
  dirs.push(dir);
  const prog = join(dir, 'render.jq');
  const input = join(dir, 'story.json');
  writeFileSync(prog, renderer());
  writeFileSync(input, JSON.stringify({ fixSiteAnalysis: sites }));
  return execFileSync('jq', ['-r', '-f', prog, input], { encoding: 'utf8' });
}

const PRODUCER = {
  file: 'src/services/pageService.ts', function: 'getPage', reason: 'orchestrates the fetch',
  fix: 'pass live_preview: true through to getEntry', deliveryRole: 'produces', runsIn: 'server',
};
const CARRIER = {
  file: 'src/context/Ctx.tsx', function: 'Provider', reason: 'exposes it to consumers',
  fix: 'subscribe and re-render', deliveryRole: 'carries', runsIn: 'browser',
};

describe('the harness renders the real thing', () => {
  it('a plain fix site still renders as before', () => {
    const out = render([CARRIER]);
    expect(out, 'the renderer produced nothing — every assertion below would be vacuous')
      .toContain('src/context/Ctx.tsx');
    expect(out).toContain('subscribe and re-render');
  });
});

describe('THE PRODUCER IS MARKED, AND UNMISTAKABLY', () => {
  it('the site that makes the value exist is called out', () => {
    const out = render([PRODUCER, CARRIER]);
    expect(out, 'nothing in the prescription tells the writer which change obtains the data')
      .toMatch(/produces/i);
  });

  it('the marking is attached to the RIGHT file', () => {
    const out = render([PRODUCER, CARRIER]);
    const producerLine = out.split('\n').find((l) => l.includes('pageService.ts')) || '';
    expect(producerLine, 'the producer marking landed on the wrong site').toMatch(/produce/i);
    const carrierLine = out.split('\n').find((l) => l.includes('Ctx.tsx')) || '';
    expect(carrierLine, 'a carrier is being presented as the producer').not.toMatch(/produces the/i);
  });

  it('WHERE IT RUNS is rendered too', () => {
    // The other half of the same defect: a browser-only API prescribed inside a server entry
    // point is unbuildable, and the writer was never told which context a change belongs to.
    const out = render([PRODUCER, CARRIER]);
    expect(out).toMatch(/server/i);
    expect(out).toMatch(/browser/i);
  });
});

describe('A PLAN WITH NO PRODUCER IS FLAGGED TO THE WRITER', () => {
  it('every site carrying or verifying is called out as incomplete', () => {
    // The live shape. If no prescribed change obtains the value, the writer must be told that
    // rather than left to infer it from four equal-looking bullets.
    const out = render([CARRIER, { ...CARRIER, file: 'src/pages/_app.tsx' }]);
    // Anchored on the WARNING ITSELF, not on any phrase in its body. A looser alternation
    // matched leftover words from the same sentence, so deleting the warning header still
    // "passed" — caught by mutation.
    expect(out, 'a prescription that never obtains the value reads as complete')
      .toMatch(/NONE OF THESE PRODUCE THE VALUE/);
  });

  it('a plan WITH a producer is not flagged', () => {
    const out = render([PRODUCER, CARRIER]);
    expect(out, 'a complete plan was flagged as missing its source')
      .not.toMatch(/NONE OF THESE PRODUCE THE VALUE/);
  });
});

describe('ABSENT IS NOT "CARRIES"', () => {
  it('a site that stated nothing is not rendered as though it had', () => {
    // Absent means the detective did not answer — older prescriptions have no deliveryRole at
    // all. Rendering that as a claim would put words in the detective's mouth.
    const out = render([{ file: 'a.ts', reason: 'r', fix: 'f' }]);
    expect(out).toContain('a.ts');
    expect(out, 'an unstated deliveryRole was rendered as a claim')
      .not.toMatch(/produces|carries|verifies/i);
  });
});
