/**
 * THE ROSTER MUST BELONG TO THE PROJECT BEING BUILT.
 *
 * `epam new generate` mints project-specific agent roles: proposeAgents() asks for
 * "2-6 project-specific engineering agent roles... each mapping to a distinct domain
 * of the project", on top of the 21 generic FIXED_AGENT_ROLES. That call exists,
 * is tested, and is reachable — and is invoked from exactly one place: the interactive
 * `epam new` scaffold command.
 *
 * The brownfield Jira pipeline never calls it. So no client codeline has ever had a
 * role minted for it, and synthesize-prd-from-jira.js closed the gap with a literal:
 *
 *     agentRole: tmpl.agentRole || 'typescript-engineer',        // line 199
 *
 * Live consequence, orchestrations/projects/metrolinx/prd.json:
 *
 *     AMSD-2041 -> typescript-engineer
 *
 * and that agent's system prompt in profiles.json describes epam-cli's OWN internals
 * (Commander.js, src/cli, Repl.ts, SlashCommands.ts — 5 references). A Contentstack
 * change on a Metrolinx Angular codeline was written by an agent briefed on this repo's
 * CLI. The roster metrolinx runs is epam-cli's first-commit roster: billing-engineer,
 * cli-ux-engineer, agent-systems-engineer.
 *
 * THE CONTRACT: at synthesis time the roster does not exist yet — the codeline has not
 * been analysed, nothing has been minted. A step that cannot know the answer must not
 * invent one. It defers, and assignment happens after minting, against the live roster.
 *
 * A hardcoded fallback is indistinguishable from a correct assignment downstream, which
 * is exactly why this survived: it never errored, it was just always wrong.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
const SCRIPT = join(__dirname, '../../../orchestrations/scripts/synthesize-prd-from-jira.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL synthesis script over fixtures and return the PRD it wrote. */
function synthesize(opts: {
  classifications: unknown[];
  template?: Record<string, unknown>;
  env?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'synth-roster-')); dirs.push(dir);
  const cPath = join(dir, 'classifications.json');
  const tPath = join(dir, 'template.json');
  const out = join(dir, 'prd.json');

  writeFileSync(cPath, JSON.stringify(opts.classifications));
  writeFileSync(tPath, JSON.stringify(opts.template ?? { title: 't', stories: [] }));

  const res = spawnSync(NODE, [SCRIPT, '--classifications', cPath, '--template', tPath, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_BROWNFIELD: '1', JIRA_DEFAULT_CODELINE: 'metrolinx', ...(opts.env ?? {}) },
  });

  let prd: any = null;
  try { prd = JSON.parse(readFileSync(out, 'utf8')); } catch { /* leave null */ }
  return { res, prd, out };
}

const TICKET = [{
  storyId: 'AMSD-2041',
  jiraKey: 'AMSD-2041',
  title: 'Enable live preview',
  description: 'A description long enough to be substantive content for the spec pass.',
  codeline: 'metrolinx',
  verdict: 'pass',
  originalAcs: [],
}];

describe('the fixture is real — otherwise every assertion below is vacuous', () => {
  it('the script runs and writes a PRD with the story in it', () => {
    const { res, prd } = synthesize({ classifications: TICKET });
    expect(res.status, `script failed: ${res.stderr}`).toBe(0);
    expect(prd, 'no PRD was written — nothing below proves anything').toBeTruthy();
    expect(prd.stories).toHaveLength(1);
    expect(prd.stories[0].jiraKey).toBe('AMSD-2041');
  });
});

describe('synthesis does not invent a role it cannot know', () => {
  it('THE DEFECT: no hardcoded role literal is assigned when the template has none', () => {
    const { prd } = synthesize({ classifications: TICKET });
    expect(
      prd.stories[0].agentRole,
      'synthesis picked a role before any roster was minted for this codeline — ' +
      'the literal fallback that put every client ticket on epam-cli\'s own generalist',
    ).toBeFalsy();
  });

  it('the deferral is EXPLICIT, so a later step can tell "unassigned" from "forgotten"', () => {
    const { prd } = synthesize({ classifications: TICKET });
    expect(
      Object.prototype.hasOwnProperty.call(prd.stories[0], 'agentRole'),
      'the key vanished entirely — downstream cannot distinguish deferred from malformed',
    ).toBe(true);
    expect(prd.stories[0].agentRole).toBeNull();
  });

  it('no role literal appears anywhere in the synthesized PRD', () => {
    const { out } = synthesize({ classifications: TICKET });
    const raw = readFileSync(out, 'utf8');
    expect(
      raw,
      'a role name is baked into the pipeline output despite the no-hardcoding rule',
    ).not.toMatch(/typescript-engineer/);
  });
});

describe('an explicit role on the template is still honoured', () => {
  it('a template that names a role keeps it — this is configuration, not invention', () => {
    const { prd } = synthesize({
      classifications: TICKET,
      template: { title: 't', stories: [{ id: 'AMSD-2041', agentRole: 'some-project-engineer' }] },
    });
    expect(prd.stories[0].agentRole).toBe('some-project-engineer');
  });
});

describe('the rest of the story is untouched by this change', () => {
  it('description, codeline and components still survive synthesis', () => {
    const { prd } = synthesize({
      classifications: [{ ...TICKET[0], components: ['Web'] }],
    });
    const s = prd.stories[0];
    expect(s.description).toMatch(/substantive content/);
    expect(s.codeline).toBe('metrolinx');
    expect(s.components).toEqual(['Web']);
    expect(s.agentGroup).toBeTruthy();
  });
});
