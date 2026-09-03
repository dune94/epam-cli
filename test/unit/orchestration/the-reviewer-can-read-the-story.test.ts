import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE REVIEWER MUST BE ABLE TO READ THE STORY IT REVIEWS.
 *
 * team-lead-review.sh had an `export` inserted INSIDE a line-continued command:
 *
 *     STORY_COMPLETED=$(jq -r --arg id "$story_id" \
 *     export STORY_COMPLETED
 *         (the jq filter) "$PRD_FILE")
 *
 * so jq received `export STORY_COMPLETED` as its arguments and the filter line ran as a shell
 * command — "command not found". Introduced by 0d754d49 ("183 shellcheck warnings down to 49"): a
 * lint cleanup that broke the reviewer.
 *
 * It is SYNTACTICALLY VALID, so `bash -n` passes and shellcheck is happy. Only executing it fails,
 * which is why this test runs the extraction rather than reading the file.
 *
 * Live 2026-09-03: the reviewer produced no verdict eight cycles in a row and Step 3.6 halted the
 * phase — correctly, because it refuses to read "no answer" as approval. Everything before it had
 * passed: the writer, scoped verification, the repro-test writer, and the repro gate.
 */
describe('the reviewer reading its story', () => {
  const REPO = path.resolve(__dirname, '../../..');
  const reviewer = path.join(REPO, 'orchestrations/scripts/team-lead-review.sh');

  it('extracts the story fields without executing any of them as commands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-'));
    const prd = path.join(dir, 'prd.json');
    fs.writeFileSync(prd, JSON.stringify({
      stories: [{ id: 'S-1', title: 'A title', agentRole: 'an-engineer', completed: false }],
    }));

    // the real extraction block, lifted verbatim from the reviewer
    const body = fs.readFileSync(reviewer, 'utf8');
    const start = body.indexOf('    STORY_TITLE=$(jq -r --arg id "$story_id"');
    expect(start, 'story-field extraction not found in the reviewer').toBeGreaterThan(-1);
    const end = body.indexOf('\n\n', body.indexOf('STORY_COMPLETED', start));
    const block = body.slice(start, end);
    expect(block, 'lifted the wrong block').toContain('STORY_COMPLETED');

    const harness = `
set -uo pipefail
story_id="S-1"
PRD_FILE="${prd}"
log() { :; }
${block}
echo "TITLE=[$STORY_TITLE]"
echo "AGENT=[$STORY_AGENT]"
echo "COMPLETED=[\${STORY_COMPLETED:-<UNSET>}]"
`;
    const r = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout ?? ''}`;
    const err = `${r.stderr ?? ''}`;

    expect(out.length, 'harness produced nothing — vacuous pass').toBeGreaterThan(0);

    // the defect announces itself in stderr; bash -n never sees it
    expect(err, `the reviewer executed part of itself as a command:\n${err}`)
      .not.toMatch(/command not found/i);

    expect(out).toContain('TITLE=[A title]');
    expect(out).toContain('AGENT=[an-engineer]');
    expect(out, 'STORY_COMPLETED never got a value, so the reviewer runs without its story')
      .toContain('COMPLETED=[false]');
  });
});
