/**
 * The writer's "BROWNFIELD SURGEON MODE" constitution (claude.sh, injected when
 * EPAM_BROWNFIELD=1) told every story — defect or novel — to avoid new files unless the
 * description used the words "create"/"add new"/"build new", and to "find the existing
 * code path that handles the behavior described in this story".
 *
 * AMSD-2041 (storyKind: novel — Contentstack Live Preview, a capability that does not
 * exist yet) has a description that is just its own title repeated. No trigger word will
 * ever appear, and there is no existing code path handling live preview to find — the
 * constitution's own rule 6 asks the writer to search for something that isn't there.
 * claude.sh already resolves story.storyKind elsewhere in this same file (line ~5402,
 * citing this exact ticket) for reasoning-effort selection — this reuses that same lookup
 * for the constitution text instead of adding a second one.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

function makePrd(dir: string, storyKind: string) {
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'AMSD-2041', storyKind, description: 'Live Preview of Content in CMS' }],
  }));
  return prd;
}

/** Runs the constitution-assembly snippet in isolation, real jq, real file, no LLM call. */
function renderConstitution(storyKind: string): string {
  const dir = mktempFixture();
  const prd = makePrd(dir, storyKind);
  const script = `
    set -uo pipefail
    story_id="AMSD-2041"
    MAIN_PRD_FILE="${prd}"
    PRD_FILE="${prd}"
    DYNAMIC_CONSTITUTION=""
    EPAM_BROWNFIELD=1
    ${extractBlock()}
    printf '%s' "$DYNAMIC_CONSTITUTION"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function mktempFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bfw-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const CLAUDE_SRC = require('node:fs').readFileSync(CLAUDE_SH, 'utf8');
function extractBlock(): string {
  const start = CLAUDE_SRC.indexOf('if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then\n        # Rules 6-9 branch on storyKind');
  const marker = '_bfw_story_kind';
  const markerIdx = CLAUDE_SRC.indexOf(marker, start);
  expect(markerIdx, 'BROWNFIELD SURGEON MODE block not found').toBeGreaterThan(0);
  const firstFi = CLAUDE_SRC.indexOf('\n    fi\n', markerIdx);
  const end = CLAUDE_SRC.indexOf('\n    fi\n', firstFi + 1);
  return CLAUDE_SRC.slice(start, end + '\n    fi\n'.length);
}

describe('the brownfield writer constitution respects storyKind', () => {
  it('THE BUG: a novel story is not told to find an existing code path that does not exist', () => {
    const out = renderConstitution('novel');
    expect(
      out,
      'AMSD-2041 has no existing live-preview code path to find — rule 6 as written asks ' +
        'the writer to search for something that cannot exist for a genuinely new capability',
    ).not.toMatch(/FIND FIRST.*existing code path that handles the behavior/s);
  });

  it('a novel story IS permitted new files without a magic trigger word', () => {
    const out = renderConstitution('novel');
    expect(
      out,
      "the old rule required the description to literally contain 'create'/'add new'/" +
        "'build new' — AMSD-2041's description is just its own title and will never match",
    ).not.toMatch(/NO NEW FILES BY DEFAULT.*explicitly uses the words/s);
  });

  it('a defect story keeps the original fix-minimally framing', () => {
    const out = renderConstitution('defect');
    expect(out).toMatch(/FIND FIRST/);
    expect(out, 'a defect DOES have a known, bounded fix site to find').toMatch(/existing code path|fix site/i);
  });

  it('an unclassified story (storyKind absent) falls back to the defect framing, not silence', () => {
    const out = renderConstitution('');
    expect(out.length, 'an empty constitution block leaves the writer with zero brownfield guidance').toBeGreaterThan(0);
  });
});
