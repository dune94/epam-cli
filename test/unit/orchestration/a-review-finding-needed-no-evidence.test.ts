// THE REVIEWER COULD ASSERT ANYTHING AND THE PIPELINE TREATED IT AS A FINDING.
//
// code-review-json.py accepted any object carrying a `verdict` key. No required fields on an
// issue, no legal-value check on severity, and — the one that cost real work — no obligation to
// say what was READ to justify a claim.
//
// Live metrolinx AMSD-2041, 2026-08-19. Across runs the reviewer twice asserted that the
// `live_preview` config "uses `management_token` instead of the prescribed `preview_token`, which
// the Contentstack Delivery SDK will not recognize". The installed SDK declares:
//
//     export interface LivePreview { host: string; management_token: string; enable: boolean }
//
// and contains ZERO occurrences of preview_token. The code was right and the review was wrong,
// and the writer had to defend correct code against it — eventually shipping a comment saying
// "Do not rename to `preview_token` — the SDK would ignore it."
//
// On an EARLIER draw the same seam got it right, unprompted: "I verified the live_preview shape
// against the installed contentstack SDK's index.d.ts — the SDK declares `management_token`, not
// the plan's `preview_token`, so that deviation from the plan is justified." Same seam, same model
// tier, opposite verdicts on a checkable fact. Correctness was luck because nothing required it.
//
// THE ENGINE ALREADY SOLVED THIS ELSEWHERE. gate_verdict_schema.py validates QA gate output and
// feeds the reason back into the retry — its own header says a gate's answer used to be accepted
// on `grep -qE '"verdict"'` alone. Neither review seam used it: grep -c on team-lead-review.sh and
// code-review-cycle.sh returned 0 and 0.
//
// An unevidenced claim is not a finding.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PARSER = join(ROOT, 'orchestrations/scripts/lib/handlers/code-review-json.py');

function parse(raw: string): { verdict: string; issues?: { severity?: string; evidence?: string; description?: string }[]; summary?: string } {
  const r = spawnSync('python3', [PARSER], { input: raw, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`parser exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const issue = (extra: Record<string, unknown> = {}) => ({
  severity: 'blocker',
  file: 'src/services/contentstack.ts',
  line: 79,
  description: 'uses management_token instead of the prescribed preview_token',
  suggestedFix: 'rename the key',
  ...extra,
});

describe('what must not regress', () => {
  it('an unparseable answer still blocks rather than approving', () => {
    const out = parse('the model rambled and never emitted JSON');
    expect(out.verdict).toBe('changes_requested');
    expect(out.issues?.[0].severity).toBe('blocker');
  });

  it('a clean approval is still an approval', () => {
    expect(parse(JSON.stringify({ verdict: 'approved', issues: [], summary: 'fine' })).verdict)
      .toBe('approved');
  });

  it('a well-formed, evidenced finding survives intact', () => {
    const out = parse(JSON.stringify({
      verdict: 'changes_requested',
      issues: [issue({ evidence: 'node_modules/contentstack/index.d.ts:123 declares management_token' })],
      summary: 's',
    }));
    expect(out.verdict).toBe('changes_requested');
    expect(out.issues).toHaveLength(1);
    expect(out.issues?.[0].evidence).toMatch(/index\.d\.ts/);
  });
});

describe('an issue without evidence is not a finding', () => {
  it('is dropped rather than acted on', () => {
    const out = parse(JSON.stringify({
      verdict: 'changes_requested',
      issues: [issue()],           // no evidence field — exactly the management_token claim
      summary: 's',
    }));
    expect(out.issues ?? [], 'an ungrounded assertion was passed on as a blocker').toHaveLength(0);
  });

  it('and a verdict left with no findings becomes an approval, not a phantom rejection', () => {
    // changes_requested with every issue dropped means the reviewer raised nothing it could
    // support. Keeping the rejection would block a story on claims that were discarded.
    const out = parse(JSON.stringify({ verdict: 'changes_requested', issues: [issue()], summary: 's' }));
    expect(out.verdict).toBe('approved');
  });

  it('says what it dropped, so a silent downgrade is impossible', () => {
    const r = spawnSync('python3', [PARSER], {
      input: JSON.stringify({ verdict: 'changes_requested', issues: [issue()], summary: 's' }),
      encoding: 'utf8',
    });
    expect(r.stderr, 'the pipeline changed a verdict and said nothing').toMatch(/evidence/i);
  });

  it('drops only the unevidenced ones, keeping the rest', () => {
    const out = parse(JSON.stringify({
      verdict: 'changes_requested',
      issues: [issue(), issue({ evidence: 'src/pages/_app.tsx:20 imports a server-only module' })],
      summary: 's',
    }));
    expect(out.issues).toHaveLength(1);
    expect(out.issues?.[0].evidence).toMatch(/_app\.tsx/);
    expect(out.verdict).toBe('changes_requested');
  });

  it('treats a blank or placeholder evidence string as absent', () => {
    for (const ev of ['', '   ', 'n/a', 'N/A', 'none']) {
      const out = parse(JSON.stringify({ verdict: 'changes_requested', issues: [issue({ evidence: ev })], summary: 's' }));
      expect(out.issues ?? [], `evidence "${ev}" was accepted as grounding`).toHaveLength(0);
    }
  });
});

describe('the reviewer is told the obligation', () => {
  for (const t of ['code-review-cycle', 'team-lead-review']) {
    it(`${t} asks for evidence on every issue`, () => {
      const j = JSON.parse(readFileSync(join(ROOT, `orchestrations/prompts/templates/${t}.json`), 'utf8'));
      const body = String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
      expect(body, 'the schema drops unevidenced issues but the prompt never asked for evidence')
        .toMatch(/evidence/i);
    });
  }
});
