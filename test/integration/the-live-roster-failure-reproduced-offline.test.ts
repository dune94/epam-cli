/**
 * THE 2026-08-31 LIVE FAILURE, REPRODUCED FOR £0.
 *
 * The metrolinx run reached the roster step and died:
 *
 *     [roster] attempt 1/3 REFUSED: checkout-form-engineer: seam 'implementer' is not declared
 *
 * It cost a launch to find, and I had told the operator this class could only be found live —
 * because 32 seams have no project prompt until a model generates them, so nothing downstream of
 * the mint could be driven offline.
 *
 * That was wrong twice over. buildProjectPrompts takes `runText` as a parameter, so the whole
 * prompt layer provisions for nothing. And buildProjectRoster takes `produce` as a parameter, so
 * the model that writes the roster is injectable too.
 *
 * This drives the REAL buildProjectRoster against a REAL provisioned project, with `produce`
 * returning exactly what the live model returned. Nothing here is a hand-built entry handed
 * straight to a validator: the fixture is provisioned the way a run provisions, and the roster
 * travels the path a run travels.
 *
 * Revert the fix in project-roster.js and this reproduces the live refusal, word for word.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionProject, REPO } from '../helpers/provisioned-project';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { buildProjectRoster, personaDigest } = require(join(REPO, 'orchestrations/scripts/lib/project-roster.js'));

const CANONICAL = join(REPO, 'orchestrations/agents/profiles.json.original');

/**
 * The roster the live model wrote, in the shape roster-specialisation asks for: every canonical
 * agent carried through, plus the two this project minted — one of which names its KIND in the
 * seam field, which is what the run died on.
 */
function produceLikeTheLiveModel(seamValue: string) {
  return async ({ outPath }: { outPath: string }) => {
    const canonical = JSON.parse(readFileSync(CANONICAL, 'utf8'));
    const agents: Record<string, unknown> = {};
    for (const [name, persona] of Object.entries<string>(canonical)) {
      if (name.startsWith('_') || name === 'runId') continue;
      agents[name] = {
        persona, kind: 'seam', ancestor: name, derivedFromSha256: personaDigest(persona),
      };
    }
    const minted = 'You implement the checkout form change in the codeline you are given.';
    agents['checkout-form-engineer'] = {
      persona: minted,
      kind: 'implementer',
      ancestor: 'checkout-form-engineer',
      derivedFromSha256: personaDigest(minted),
      seam: seamValue,
    };
    writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
  };
}

async function runRoster(seamValue: string) {
  const project = await provisionProject();
  // THE MINT REGISTERS ITS ROLES BEFORE THE ROSTER IS BUILT, and self-ancestry is only permitted
  // for an agent the project has registered — the check that stops a model inventing an agent with
  // no provenance. A fixture that skipped this was failing on ancestry and never reaching the seam
  // question at all. This is the file the live run wrote: {"roles": ["checkout-form-engineer"]}.
  writeFileSync(join(project.dir, 'project-roles.json'),
    JSON.stringify({ roles: ['checkout-form-engineer'] }, null, 2));
  const logDir = mkdtempSync(join(tmpdir(), 'roster-log-'));
  const prevDir = process.env.EPAM_PROJECT_CONFIG_DIR;
  process.env.EPAM_PROJECT_CONFIG_DIR = project.dir;
  const messages: string[] = [];
  try {
    const roster = await buildProjectRoster({
      canonicalPath: CANONICAL,
      logDir,
      projectConfigDir: project.dir,
      produce: produceLikeTheLiveModel(seamValue),
      review: async () => ({ verdict: 'approved', findings: [] }),   // the word the real path accepts
      attempts: 1,
      log: (m: string) => messages.push(m),
    });
    return { ok: true, roster, messages, error: '' };
  } catch (e: unknown) {
    return { ok: false, roster: null, messages, error: String((e as Error).message || e) };
  } finally {
    if (prevDir === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR;
    else process.env.EPAM_PROJECT_CONFIG_DIR = prevDir;
  }
}

describe('the live roster failure, reproduced offline', () => {
  it('the fixture is a genuinely provisioned project, not an empty directory', async () => {
    // Without this the run below could "pass" by never reaching anything that needs a prompt.
    const p = await provisionProject();
    expect(p.count, 'nothing was provisioned; this test would prove nothing').toBeGreaterThan(30);
  }, 240_000);

  it('a minted agent naming its KIND in the seam field no longer kills the mint', async () => {
    // THE LIVE CASE, verbatim: seam: "implementer" on checkout-form-engineer.
    const r = await runRoster('implementer');
    expect(r.ok, `the roster build failed exactly as the live run did: ${r.error}`).toBe(true);
    expect(Object.keys(r.roster.agents), 'the minted agent did not survive into the roster')
      .toContain('checkout-form-engineer');
  }, 240_000);

  it('and a seam that is neither declared nor a kind is still refused', async () => {
    // The negative half: this must not have become "accept anything".
    const r = await runRoster('not-a-real-seam');
    const said = `${r.error}\n${r.messages.join('\n')}`;
    expect(said, 'an invented seam name was accepted').toMatch(/not declared in the registry/);
  }, 240_000);

  it('the refusal it gives names the seam the resolver derives', async () => {
    const r = await runRoster('not-a-real-seam');
    const said = `${r.error}\n${r.messages.join('\n')}`;
    expect(said, 'the refusal gives the model no route out, so the retry repeats the mistake')
      .toMatch(/story-writer/);
  }, 240_000);
});
