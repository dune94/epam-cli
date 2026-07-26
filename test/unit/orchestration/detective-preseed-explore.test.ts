/**
 * The detective should start from data, not spend turns rediscovering it.
 *
 * Its own prompt says: "First call: `explore` with the DOMAIN NOUNS only". That
 * first call is fully deterministic — the query comes from the ticket, and
 * buildBrownfieldSearchQuery() already computes exactly that noun set (it is
 * the same stopword-stripped query proven to rank the real fix site #1). So the
 * pipeline can run it for free, before the model is invoked, and hand over the
 * result.
 *
 * Why it matters: the model's iteration budget is the scarce resource here.
 * glm-5.1 exhausted the cap at 10 (7 runs), 20 (9 runs), 25 (3 runs) and 40
 * (the worst — 40 tool calls, 680K input tokens, no answer). Every turn spent
 * re-deriving a query we can compute deterministically is a turn not spent
 * tracing callers, which is the part that actually needs judgement.
 *
 * Best-effort by construction: a missing tool, a broken index or a slow query
 * must degrade to "no pre-seed" and never break the spec pass.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { precomputeDetectiveExplore } = require('../../../orchestrations/scripts/spec-mode-runner.js');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stub codegraph tool that echoes how it was invoked, plus canned results. */
function makeTool(body?: string): { toolPath: string; repoPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'detective-preseed-'));
  cleanupDirs.push(dir);
  const toolPath = join(dir, 'codegraph-agent-query.sh');
  writeFileSync(
    toolPath,
    body ??
      `#!/usr/bin/env bash
echo "PROJECT_ROOT=\${PROJECT_ROOT}"
echo "ARGS=$*"
echo "rank 1: applyReportDiscountsService  src/services/submit-reservations/apply-report-discounts.service.ts"
`,
  );
  chmodSync(toolPath, 0o755);
  return { toolPath, repoPath: dir };
}

const STORY = {
  id: 'AMSD-1820',
  title: '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation',
  acceptanceCriteria: [],
};

describe('the first explore is computed, not asked for', () => {
  it('returns the tool output so it can be handed to the model', () => {
    const { toolPath, repoPath } = makeTool();
    const out = precomputeDetectiveExplore(repoPath, STORY, toolPath, {});

    expect(out, 'nothing was pre-computed — the model still has to spend a turn on it')
      .toMatch(/applyReportDiscountsService/);
  });

  it('passes PROJECT_ROOT, which the tool requires', () => {
    const { toolPath, repoPath } = makeTool();
    expect(precomputeDetectiveExplore(repoPath, STORY, toolPath, {}))
      .toMatch(new RegExp(`PROJECT_ROOT=${repoPath}`));
  });

  it('queries the DOMAIN nouns, dropping the symptom words', () => {
    // Searching the raw title ranks the display/mapper layer and buries the
    // real fix site — the defect buildBrownfieldSearchQuery exists to fix.
    const { toolPath, repoPath } = makeTool();
    const args = (precomputeDetectiveExplore(repoPath, STORY, toolPath, {}).match(/ARGS=(.*)/) || [, ''])[1];

    expect(args, 'the explore subcommand was not used').toMatch(/^explore /);
    expect(args, 'domain nouns missing from the query').toMatch(/promo/);
    expect(args, 'a presentation word leaked into the query and will skew the ranking')
      .not.toMatch(/displayed|confirmation/);
  });

  it('degrades to nothing when the tool is missing — never throws', () => {
    const { repoPath } = makeTool();
    expect(() => precomputeDetectiveExplore(repoPath, STORY, '/nonexistent/tool.sh', {})).not.toThrow();
    expect(precomputeDetectiveExplore(repoPath, STORY, '/nonexistent/tool.sh', {})).toBe('');
  });

  it('degrades to nothing when the tool fails', () => {
    const { toolPath, repoPath } = makeTool('#!/usr/bin/env bash\necho "index missing" >&2\nexit 3\n');
    expect(precomputeDetectiveExplore(repoPath, STORY, toolPath, {})).toBe('');
  });

  it('caps the output — a pre-seed must not swallow the context window', () => {
    const { toolPath, repoPath } = makeTool(
      '#!/usr/bin/env bash\nfor i in $(seq 1 5000); do echo "rank $i: some::symbol path/to/file.ts"; done\n',
    );
    const out = precomputeDetectiveExplore(repoPath, STORY, toolPath, {});
    expect(out.length, 'an unbounded tool result was injected verbatim').toBeLessThanOrEqual(8000);
    expect(out, 'the truncation is silent — the model cannot tell it saw a partial list')
      .toMatch(/truncat/i);
  });

  it('can be turned off per project', () => {
    const { toolPath, repoPath } = makeTool();
    expect(precomputeDetectiveExplore(repoPath, STORY, toolPath, { CODEGRAPH_DETECTIVE_PRESEED: '0' })).toBe('');
  });

  it('returns nothing when the ticket yields no domain nouns', () => {
    const { toolPath, repoPath } = makeTool();
    expect(precomputeDetectiveExplore(repoPath, { id: 'X', title: '', acceptanceCriteria: [] }, toolPath, {})).toBe('');
  });
});

describe('the pre-seed reaches the model', () => {
  const SPEC = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('is injected into the detective prompt', () => {
    expect(SPEC, 'computed but never handed over').toMatch(/precomputeDetectiveExplore/);
  });

  it('tells the model this counts as its first call, so it does not repeat it', () => {
    expect(SPEC).toMatch(/ALREADY RUN|already run|pre-computed|PRE-COMPUTED/);
  });
});
