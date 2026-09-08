/**
 * THE REVIEWER CAN BOOTSTRAP FROM ITS TEMPLATE — and nothing else may.
 *
 * THE STANDING RULE, from prompt-library.js's header, operator 2026-08-11, verbatim:
 *   "WE WILL NEVER EVER run the template version of the prompts - NEVER. NEVER - no fallbacks.
 *    Only project authority prompts."
 * That rule exists because a template is generic: running it unspecialised gives every project
 * the same prompt, which is the defect the whole prompt layer was built to remove.
 *
 * THE ONE CASE IT CANNOT COVER is the reviewer's own prompt. Prompts are reviewed as they are
 * generated, and prompt-review.json is itself one of the generated prompts — so the FIRST prompts
 * of a fresh project are reviewed by a reviewer whose own project prompt does not exist yet.
 * Live 2026-09-08, pipeline-tests-45:
 *
 *   [prompt-review] prompt-review: could not build the reviewer's prompt (project-authority prompt
 *   missing: .../metrolinx/prompts/prompt-review.json ...) — installing UNREVIEWED
 *
 * The run logged "prompt review ENABLED" and installed prompts unreviewed anyway. A gate that
 * silently fails open is worse than one that is switched off, because the log claims cover.
 *
 * Operator, 2026-09-08: "If a project level prompt-review prompt is not available - then defer to
 * app level prompt." So the exception is granted, and it is kept as narrow as the reason for it:
 * the REVIEWER'S OWN prompt, only when it is genuinely absent, and said out loud when used.
 * Every agent prompt keeps the hard failure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makePromptReviewer, makePromptRenderer } = require(join(ROOT, 'orchestrations/scripts/lib/prompt-review.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const promptsLib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A project config dir with NO prompts — exactly a fresh project's first generation. */
function emptyProject() {
  const d = mkdtempSync(join(tmpdir(), 'bootstrap-')); dirs.push(d);
  mkdirSync(join(d, 'prompts'), { recursive: true });
  return d;
}

function reviewer(projectConfigDir: string, warns: string[], invoked: string[]) {
  return makePromptReviewer({
    // The SAME renderer the mint injects — makePromptRenderer(promptsLib) — so this exercises the
    // real resolution path rather than a stand-in that cannot fail the way production does.
    render: makePromptRenderer(promptsLib),
    invoke: async (prompt: string) => { invoked.push(prompt); return '{"ok":true}'; },
    // THE EIGHT VALUES THE TEMPLATE DECLARES. The renderer is strict in both directions, so an
    // empty values object fails for a reason that has nothing to do with the fallback under test.
    values: ({ id, template, generated }: any) => ({
      __PERSONA__: '', __ROSTER_BLOCK__: '', __TICKET_BLOCK__: '', __CODELINE_BLOCK__: '',
      __TOOL_LINE__: '', __PROMPT_ID__: String(id),
      __TEMPLATE_BODY__: String((template && template.body) || ''),
      __GENERATED_BODY__: String((generated && generated.body) || ''),
    }),
    warn: (m: string) => warns.push(m),
    projectConfigDir,
  });
}

describe('the reviewer can bootstrap from its template', () => {
  it('GUARD: a fresh project genuinely has no reviewer prompt', () => {
    const dir = emptyProject();
    expect(() => promptsLib.loadProjectPrompt('prompt-review', dir),
      'the fixture already has a project prompt, so this suite proves nothing').toThrow(/missing/i);
  });

  it('REVIEWS ANYWAY, from the template, rather than installing unreviewed', async () => {
    const dir = emptyProject();
    const warns: string[] = []; const invoked: string[] = [];
    const review = reviewer(dir, warns, invoked);
    await review({ id: 'some-prompt', template: { id: 'some-prompt', body: 'x' }, generated: { body: 'y' } });
    expect(invoked.length,
      'the reviewer still did not run — the first prompts of every fresh project install unreviewed '
      + 'while the log claims review is enabled').toBeGreaterThan(0);
  });

  it('SAYS SO OUT LOUD — a template-sourced review is not silently equivalent', async () => {
    const dir = emptyProject();
    const warns: string[] = []; const invoked: string[] = [];
    await reviewer(dir, warns, invoked)({ id: 'p', template: { id: 'p', body: 'x' }, generated: { body: 'y' } });
    expect(warns.join(' '), 'falling back to the template was not reported, so an operator cannot '
      + 'tell a project-authority review from a generic one').toMatch(/template/i);
  });

  it('THE STANDING RULE HOLDS FOR EVERY OTHER PROMPT — no blanket fallback', () => {
    const dir = emptyProject();
    for (const id of ['spec-agent-openspec', 'team-lead-review', 'story-writer']) {
      expect(() => promptsLib.loadProjectPrompt(id, dir),
        `${id} fell back to its template — the mandate is "no fallbacks" for agent prompts`)
        .toThrow(/missing|NEVER/i);
    }
  });

  it('ONCE THE PROJECT COPY EXISTS, that is what is used', async () => {
    const dir = emptyProject();
    writeFileSync(join(dir, 'prompts', 'prompt-review.json'), JSON.stringify({
      id: 'prompt-review', authority: 'project', body: 'PROJECT REVIEWER BODY', placeholders: [],
    }));
    const warns: string[] = []; const invoked: string[] = [];
    await reviewer(dir, warns, invoked)({ id: 'p', template: { id: 'p', body: 'x' }, generated: { body: 'y' } });
    expect(invoked.join(' '), 'the project copy exists and was not used').toContain('PROJECT REVIEWER BODY');
    expect(warns.join(' '), 'warned about a fallback that did not happen').not.toMatch(/template/i);
  });
});
