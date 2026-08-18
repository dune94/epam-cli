/**
 * THE RESUME GUARD READ ITS OWN SOURCE FILE INSTEAD OF THE PRD.
 *
 * resume-spec-output-present.js decides whether a resume that skips the spec pass still has the
 * spec pass's output to work from. It read:
 *
 *     JSON.parse(readFileSync(process.argv[1], 'utf8'))
 *
 * argv[1] is the SCRIPT'S OWN PATH. So it parsed its own JavaScript as JSON, threw, fell into
 * `catch { process.exit(1) }`, and answered "no spec output" for every PRD ever handed to it.
 * The guard could not pass. Any resume with EPAM_SPEC_MODE=0 — which is every resume at the
 * writer, since that is what the writer-only mode sets — was refused.
 *
 * Live 2026-08-18, resuming run 20260818T101809Z. The checkpoint restored cleanly (2 stories, 13
 * spec items), pre-run-reset kept the PRD, and the PRD on disk carried 6 and 3 verification
 * criteria, 2 fix sites each and both roles. The guard still said:
 *
 *     resume '20260818T101809Z' skips the spec pass, but the PRD carries none of its output —
 *     no fixSiteAnalysis, no verificationCriteria, no declared files, no specification block.
 *
 * The six-space indent is the tell: this was lifted out of an inline shell heredoc, where $1 was
 * the argument. It is the same extraction defect as lib/handlers/prd-phases.js, which carried a
 * literal '$1' and made every lane loop zero times.
 *
 * The guard itself is right and stays: a resume that skips the spec pass and has no spec output
 * hands the writer a story with nothing to aim at — measured at $11.76 and no code.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const H = join(ROOT, 'orchestrations/scripts/lib/handlers/resume-spec-output-present.js');

function verdict(prd: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'specout-'));
  const f = join(dir, 'prd.json');
  writeFileSync(f, typeof prd === 'string' ? prd : JSON.stringify(prd));
  const r = spawnSync(process.execPath, [H, f], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r.status;
}

const story = (extra: Record<string, unknown>) => ({
  stories: [{ id: 'S-1', title: 't', ...extra }],
});

describe('the resume guard read its own source', () => {
  it('SEES VERIFICATION CRITERIA — the live shape it refused', () => {
    expect(verdict(story({ verificationCriteria: ['the fare for a rider aged 65 is the concession fare'] })),
      'a PRD carrying the spec pass output is reported as carrying none').toBe(0);
  });

  it('sees fix sites', () => {
    expect(verdict(story({ fixSiteAnalysis: [{ file: 'src/fares.ts', reason: 'boundary' }] }))).toBe(0);
  });

  it('sees a specification block', () => {
    expect(verdict(story({ specification: { status: 'completed' } }))).toBe(0);
  });

  it('sees declared files under technicalNotes', () => {
    expect(verdict(story({ technicalNotes: { files: ['src/fares.ts'] } }))).toBe(0);
  });

  it('STILL REFUSES A PRD WITH NO SPEC OUTPUT — the guard this exists to be', () => {
    expect(verdict(story({ acceptanceCriteria: ['something'] })),
      'a story with no spec output was accepted').not.toBe(0);
  });

  it('refuses empty collections rather than counting their presence', () => {
    expect(verdict(story({ verificationCriteria: [], fixSiteAnalysis: [], specification: {} })))
      .not.toBe(0);
  });

  it('refuses a PRD with no stories, and unreadable input', () => {
    expect(verdict({ stories: [] })).not.toBe(0);
    expect(verdict('{ not json')).not.toBe(0);
  });
});
