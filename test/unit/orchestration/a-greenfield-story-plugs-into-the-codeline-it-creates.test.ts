/**
 * A GREENFIELD STORY PLUGS INTO THE CODELINE IT CREATES.
 *
 * CPA blocks a NOVEL story that has no attachment point — a locationHint or fixSiteAnalysis —
 * because "a feature nobody can place is as unimplementable as a defect nobody can locate" (user
 * decision, 2026-07-28). That evidence is produced by the brownfield spec pass: the openspec
 * prompt's location-hint schema line renders EMPTY for a project declaring EPAM_BROWNFIELD=0,
 * so a greenfield story can never carry one. Every greenfield scaffold story is novel, every one
 * lacks the hint, and CPA blocked the £0 greenfield run at its first story with exit 3 — a gate
 * that no greenfield project could pass by design. Found 2026-09-13 by the greenfield integration
 * test, one stage past the specification pass.
 *
 * For a greenfield project the attachment point is the codeline the run is building: the block is
 * downgraded to review exactly as it is for a brownfield feature that names one. Brownfield keeps
 * the rule unchanged. The gate-decision block is lifted from the real script and EXECUTED.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/contextualize-stories.sh'), 'utf8');

function decide(storyJson: object, env: Record<string, string>) {
  const start = SRC.indexOf('# ── Story kind:');
  const end = SRC.indexOf('# ── Accumulate gate totals', start);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const script = `set -uo pipefail
info(){ echo "[cpa] $*"; }
gate=block; sid=STORY-1
story_json=${JSON.stringify(JSON.stringify(storyJson))}
${SRC.slice(start, end)}
echo "GATE=$gate"`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH!, ...env } });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/^GATE=(\w+)$/m);
  return { gate: m ? m[1] : '', out };
}

describe('a greenfield story plugs into the codeline it creates', () => {
  it('THE DEFECT: a novel greenfield story with no hint is downgraded to review, not blocked', () => {
    const r = decide({ id: 'STORY-1', storyKind: 'novel' }, { EPAM_BROWNFIELD: '0' });
    expect(r.gate, r.out).toBe('review');
    expect(r.out).toMatch(/greenfield/i);
  });

  it('a novel brownfield story with no hint still blocks — the rule is unchanged where it applies', () => {
    const r = decide({ id: 'STORY-1', storyKind: 'novel' }, { EPAM_BROWNFIELD: '1' });
    expect(r.gate, r.out).toBe('block');
  });

  it('a novel brownfield story WITH a hint is still downgraded to review', () => {
    const r = decide({ id: 'STORY-1', storyKind: 'novel', locationHint: ['src/x.ts'] }, { EPAM_BROWNFIELD: '1' });
    expect(r.gate, r.out).toBe('review');
  });

  it('a defect blocks whichever the project, greenfield included', () => {
    const r = decide({ id: 'STORY-1', storyKind: 'defect' }, { EPAM_BROWNFIELD: '0' });
    expect(r.gate, r.out).toBe('block');
  });
});
