/**
 * THE PROMPT-TO-SEAM LINK IS STORED TWICE, SO THE TWO COPIES DRIFT.
 *
 * invocation-profiles.json declares it authoritatively — a seam names the template it runs:
 *
 *     profiles['impl-failure-analyst'].template === 'failure-analyst'
 *
 * Every prompt document ALSO carries a `seams` array naming the seams it serves. That is a
 * hand-maintained inverse index of something already derivable, and linkPromptsToRoster reads the
 * copy rather than the source:
 *
 *     for (const seam of doc.seams || []) (bySeam[seam] ||= []).push(id);
 *
 * FOUR CONSEQUENCES, all seen live on 2026-08-17 run 20260817T211517Z:
 *
 * 1. DRIFT. The installed copy of failure-analyst said seams ["failure-analyst"] where its
 *    template says ["impl-failure-analyst"], and the link failed for two agents after 37 prompts
 *    had provisioned successfully.
 *
 * 2. N:1 IS UNREPRESENTABLE. failure-analyst is the template for BOTH agent-failure-analyst and
 *    impl-failure-analyst, and its seams array can only be one list — so even a byte-perfect copy
 *    leaves one of the two seams unlinked. This is not a bug in the copying; the model cannot
 *    express the relationship.
 *
 * 3. 36 OF 37 HIDE IT. For every other template the seam name equals the template id, so the same
 *    defect is invisible. Only the one case where they differ ever fails.
 *
 * 4. THE ERROR BLAMES THE WRONG THING. "no installed prompt declares it" points at the prompt,
 *    when the registry plainly states which template that seam runs.
 *
 * THE REMEDY IS TO DELETE THE SECOND COPY: derive seam -> prompt from the registry at link time,
 * and stop writing `seams` into generated documents. Then drift, the N:1 limit, and the false
 * negative all disappear together, and provisioning keyed by template id can be checked against
 * invocation keyed by seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { linkPromptsToRoster } = require(join(ROOT, 'orchestrations/scripts/lib/prompt-agent-link.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildGeneratedDoc } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

let work: string;
let projectDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'plink-'));
  projectDir = join(work, 'project');
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** Install a prompt exactly as the builder does — WITHOUT any seams field. */
function install(id: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(projectDir, 'prompts', `${id}.json`),
    JSON.stringify({ id, authority: 'project', body: 'x', ...extra }));
}

const link = (agents: string[]) => linkPromptsToRoster({
  projectConfigDir: projectDir, registryFile: REGISTRY, agents, write: false,
});

describe('the prompt-seam link is stored twice', () => {
  it('LINKS FROM THE REGISTRY — a prompt with no seams field still serves its seam', () => {
    // The registry says impl-failure-analyst runs the failure-analyst template. That is the whole
    // fact; the prompt does not need to restate it.
    const seam = 'impl-failure-analyst';
    install(registry().profiles[seam].template);
    const out = link(['some-analyst']);
    expect(out.agents['some-analyst'].seam).toBe(seam);
    expect(out.agents['some-analyst'].prompts,
      'the link still depends on a seams field inside the prompt')
      .toContain(registry().profiles[seam].template);
  });

  it('N:1 WORKS — one template serving two seams links for BOTH', () => {
    // failure-analyst is the template for agent-failure-analyst AND impl-failure-analyst. A seams
    // array can only name one; the registry names both.
    const reg = registry();
    const shared = Object.entries<any>(reg.profiles)
      .filter(([, p]) => p.template)
      .reduce((acc: Record<string, string[]>, [seam, p]) => {
        (acc[p.template] = acc[p.template] || []).push(seam);
        return acc;
      }, {});
    const [tpl, seams] = Object.entries(shared).find(([, s]) => s.length > 1)!;
    expect(seams.length, 'no template serves two seams — this test proves nothing').toBeGreaterThan(1);

    install(tpl);
    // Both seams must resolve to that one installed prompt.
    const bySeam = link([]).promptsBySeam;
    for (const s of seams) {
      expect(bySeam[s], `seam '${s}' has no prompt though '${tpl}' is installed`).toContain(tpl);
    }
  });

  it('A MISSING PROMPT IS STILL A GAP — the check is derived, not disabled', () => {
    // Nothing installed at all: the seam genuinely has no prompt and that must still be reported.
    expect(() => link(['some-analyst'])).toThrow(/no (installed )?prompt/i);
  });

  it('the error names the TEMPLATE the registry wanted, not just the seam', () => {
    // "no installed prompt declares it" points at the prompt. The registry knows exactly which
    // template that seam runs, and saying so is the difference between a clue and an answer.
    let msg = '';
    try { link(['some-analyst']); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/impl-failure-analyst/);
    expect(msg, 'the reader is not told which template was expected').toMatch(/failure-analyst/);
  });

  it('GENERATED DOCUMENTS NO LONGER CARRY THE SECOND COPY', () => {
    // The field is a derived duplicate; keeping it invites the drift back.
    const t = { id: 'x', body: 'b', placeholders: [], version: 1, seams: ['some-seam'] };
    const doc = buildGeneratedDoc(t, 'body');
    expect(doc.seams, 'a generated prompt still restates what the registry declares').toBeUndefined();
  });
});
