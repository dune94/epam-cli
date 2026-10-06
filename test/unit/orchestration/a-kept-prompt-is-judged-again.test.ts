/**
 * A PROMPT A RESUME KEEPS IS JUDGED AGAIN BY THE CURRENT REVIEWER — AND A REJECTION TEACHES THE NEXT ATTEMPT.
 *
 * 2026-10-06, AMSD-2974: metrolinx's generated repro-test-writer was narrowed to the one ticket in scope
 * ("write a spec file for a Toast component at cx-shared") with its run-time slots displaced. The contract
 * passed it (the slots are restored by construction), the reviewer passed it (every claim in it is true),
 * and a resume keeps whatever prompts the run built — so no correction to the generator or the reviewer
 * could ever reach that run. Operator, 2026-10-06: a resume re-reviews its kept prompts with the current
 * reviewer and regenerates only those it rejects; every rejection reaches the self-heal analyst.
 *
 * EXECUTED: the real buildProjectPrompts on the real generator, repro-test-writer and prompt-review
 * templates. The kept prompt is the real defective copy, frozen unchanged from the install
 * (test/fixtures/frozen-prompts). The model is a stand-in that answers from its input; the reviewer is a
 * stand-in whose verdict each case states — its JUDGEMENT is proven on the real model by
 * test/rehearsal/real-estate-prompts.test.ts, not here.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');
const LIB = join(REPO, 'orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const builder = require(join(LIB, 'project-prompt-builder.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contract = require(join(LIB, 'project-prompt-contract.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const selfHealMod = require(join(LIB, 'self-heal.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enginePrompt = require(join(LIB, 'engine-prompt.js'));

const FROZEN = JSON.parse(readFileSync(join(REPO, 'test/fixtures/frozen-prompts/repro-test-writer.narrowed-metrolinx-20261006.json'), 'utf8'));
const ID = 'repro-test-writer';
const tplOf = (id: string) => JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const realSelfHeal = selfHealMod.selfHeal;
// The analyst is a model call; no case here may reach one. A case that watches it installs its own.
beforeEach(() => { selfHealMod.selfHeal = () => ({ ran: false, rc: 0 }); });
afterEach(() => { selfHealMod.selfHeal = realSelfHeal; });

/** Answers from its input: every segment it is shown, back under its marker. */
const asked: string[] = [];
const echoModel = async (prompt: string) => {
  asked.push(prompt);
  const shown: string[] = [];
  const re = /^--- SEGMENT (\d+) ---\n([\s\S]*?)(?=^--- (?:SEGMENT \d+|END SEGMENTS) ---$)/gm;
  let m; while ((m = re.exec(prompt))) shown.push(m[2].replace(/\n$/, ''));
  return contract.formatSegments(shown);
};

/** A project whose resume holds the real defective copy, exactly as the install did. */
function resumedProject() {
  const dir = mkdtempSync(join(tmpdir(), 'kept-prompt-')); dirs.push(dir);
  const cfg = join(dir, 'project'); mkdirSync(join(cfg, 'prompts'), { recursive: true });
  const gen = builder.PROJECT_PROMPT_GENERATOR_ID;
  const bootstrapFile = join(dir, 'bootstrap.json');
  writeFileSync(bootstrapFile, JSON.stringify({ copyVerbatim: [gen], generated: [ID] }));
  writeFileSync(join(cfg, 'prompts', `${ID}.json`), JSON.stringify(FROZEN, null, 2) + '\n');
  const logs: string[] = [];
  const provision = (reviewPrompt?: (a: { id: string; generated: { body: string } }) => Promise<object>, attempts = 2) =>
    builder.buildProjectPrompts({
      templatesDir: TEMPLATES, projectConfigDir: cfg, bootstrapFile, mode: 'generate',
      projectContext: 'Project: metrolinx\nTickets in scope: AMSD-2974: Toast Notification (Pop-Up) Accessibility Enhancement',
      codelineContext: 'a codeline', mintedRoles: 'roles', attempts,
      log: (msg: string) => logs.push(String(msg)), runText: echoModel, keepExisting: true, reviewPrompt,
    });
  const installed = () => JSON.parse(readFileSync(join(cfg, 'prompts', `${ID}.json`), 'utf8'));
  return { provision, installed, logs, cfg };
}

describe('a rejected kept copy is not served back from the prompt cache', () => {
  it('the cache holding the same copy, marked reviewed (metrolinx\'s state), does not reinstall it', async () => {
    // Build the cache entry the builder itself writes, then put the defective copy in it — as metrolinx's
    // .prompt-cache held it: same inputs, reviewed: true.
    const p = resumedProject();
    rmSync(join(p.cfg, 'prompts', `${ID}.json`));
    await p.provision(async () => ({ ok: true, reviewed: true }));
    const cacheFiles = (readdirSync(join(p.cfg, '.prompt-cache'), { recursive: true }) as string[]).filter((f) => f.endsWith(`${ID}.json`));
    expect(cacheFiles, 'the builder wrote no cache entry — the case below would be vacuous').toHaveLength(1);
    const cf = join(p.cfg, '.prompt-cache', cacheFiles[0]);
    const entry = JSON.parse(readFileSync(cf, 'utf8'));
    writeFileSync(cf, JSON.stringify({ ...entry, doc: FROZEN, reviewed: true }, null, 2));
    writeFileSync(join(p.cfg, 'prompts', `${ID}.json`), JSON.stringify(FROZEN, null, 2) + '\n');
    let n = 0;
    await p.provision(async ({ id }) => (id === ID && n++ === 0 ? { ok: false, reviewed: true, reason: 'narrowed' } : { ok: true, reviewed: true }));
    expect(p.installed().body, 'the rejected copy came back from the cache').not.toBe(FROZEN.body);
  });
});

describe('the setup is the real defect', () => {
  it('the frozen copy is current for its template, so a resume keeps it', () => {
    expect(FROZEN.derivedFromSha256).toBe(contract.generatedTemplateDigest(tplOf(ID)));
    expect(contract.checkGeneratedPrompt(tplOf(ID), FROZEN).ok, 'the contract cannot see this defect').toBe(true);
    expect(FROZEN.body).toContain('a Toast component at cx-shared');
  });
});

describe('a resume asks the current reviewer about every prompt it keeps', () => {
  it('the kept copy is reviewed, and kept when the reviewer approves it', async () => {
    const p = resumedProject(); asked.length = 0;
    const seen: string[] = [];
    await p.provision(async ({ id, generated }) => { seen.push(`${id}\n${generated.body}`); return { ok: true, reviewed: true }; });
    expect(seen.filter((s) => s.startsWith(`${ID}\n`)), 'the kept prompt was never shown to the reviewer').toHaveLength(1);
    expect(seen[0]).toContain('a Toast component at cx-shared');
    expect(p.installed().body).toBe(FROZEN.body);
    expect(asked.filter((a) => a.includes(`Its id is ${ID}`)), 'an approved kept prompt was regenerated').toHaveLength(0);
  });

  it('a kept copy the reviewer rejects is regenerated, and the generator is told why', async () => {
    const p = resumedProject(); asked.length = 0;
    const why = 'it is narrowed to one ticket: the role and the test path are this story\'s, not run-time values';
    let n = 0;
    await p.provision(async ({ id }) => (id === ID && n++ === 0 ? { ok: false, reviewed: true, reason: why } : { ok: true, reviewed: true }));
    const regen = asked.filter((a) => a.includes(`Its id is ${ID}`));
    expect(regen, 'the rejected kept prompt was not regenerated').toHaveLength(1);
    expect(regen[0], 'the regeneration was not told why the kept copy was rejected').toContain(why);
    expect(p.installed().body).not.toBe(FROZEN.body);
    expect(contract.checkGeneratedPrompt(tplOf(ID), p.installed()).ok).toBe(true);
  });

  it('a reviewer that gives no verdict is not evidence against the kept copy — it stays, and is said to be unreviewed', async () => {
    const p = resumedProject(); asked.length = 0;
    await p.provision(async () => ({ reviewed: false, reason: 'it held no <PROMPT_REVIEW> block' }));
    expect(p.installed().body).toBe(FROZEN.body);
    expect(asked.filter((a) => a.includes(`Its id is ${ID}`))).toHaveLength(0);
    expect(p.logs.join('\n')).toMatch(new RegExp(`${ID}[^\\n]*unreviewed`, 'i'));
  });

  it('a rejected kept copy whose regeneration never passes fails provisioning by name — it is never quietly kept', async () => {
    const p = resumedProject();
    await expect(p.provision(async () => ({ ok: false, reviewed: true, reason: 'narrowed to one ticket' }), 2))
      .rejects.toThrow(new RegExp(ID));
  });

  it('with review off, a resume keeps the copy byte for byte and asks no model', async () => {
    const p = resumedProject(); asked.length = 0;
    await p.provision(undefined);
    expect(p.installed().body).toBe(FROZEN.body);
    expect(asked).toHaveLength(0);
  });
});

describe('every review rejection reaches the self-heal analyst, with what was rejected', () => {
  it('the kept copy\'s rejection', async () => {
    const calls: Array<{ agent: string; reason: string; output: string }> = [];
    selfHealMod.selfHeal = (a: { agent: string; reason: string; output: string }) => { calls.push(a); return { ran: true, rc: 0 }; };
    const p = resumedProject();
    let n = 0;
    await p.provision(async ({ id }) => (id === ID && n++ === 0 ? { ok: false, reviewed: true, reason: 'narrowed to one ticket' } : { ok: true, reviewed: true }));
    const mine = calls.filter((c) => c.agent === `prompt-builder:${ID}`);
    expect(mine, 'the rejection never reached the analyst').toHaveLength(1);
    expect(mine[0].reason).toContain('narrowed to one ticket');
    expect(mine[0].output, 'the analyst was not shown what was rejected').toContain('a Toast component at cx-shared');
  });

  it('a fresh generation\'s rejection', async () => {
    const calls: Array<{ agent: string; reason: string; output: string }> = [];
    selfHealMod.selfHeal = (a: { agent: string; reason: string; output: string }) => { calls.push(a); return { ran: true, rc: 0 }; };
    const p = resumedProject();
    let n = 0;
    // A fresh generation: nothing installed for this id, so the builder generates it.
    const dir = dirs[dirs.length - 1];
    rmSync(join(dir, 'project', 'prompts', `${ID}.json`), { force: true });
    await p.provision(async ({ id }) => (id === ID && n++ === 0 ? { ok: false, reviewed: true, reason: 'claims a directory that does not exist' } : { ok: true, reviewed: true }));
    const mine = calls.filter((c) => c.agent === `prompt-builder:${ID}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toContain('claims a directory that does not exist');
    expect(mine[0].output.length, 'the analyst was shown nothing').toBeGreaterThan(200);
  });
});

describe('what the two agents are now told', () => {
  it('the generator: the prompt serves every story and call, and a segment break is where a per-call value goes', () => {
    const generatorBody = tplOf(builder.PROJECT_PROMPT_GENERATOR_ID).body;
    const out = builder.renderGeneratorPrompt({ generatorBody, template: tplOf(ID), projectContext: 'Tickets in scope: X-1: t', codelineContext: 'c', mintedRoles: 'r', refusal: '' });
    expect(out).toContain('--- SEGMENT 1 ---');
    expect(out).toMatch(/reused for every story and every call/i);
    expect(out).toMatch(/where one segment ends and the next begins/i);
    // The self-contradiction: "never write a placeholder" beside "every placeholder must appear in what you send".
    expect(out).not.toMatch(/Every placeholder, and every output field, must appear/);
  });

  it('the reviewer: sees the template and the copy with their slots, and is asked about narrowing and displaced slots', () => {
    const tpl = tplOf('prompt-review');
    const body = tpl.body || Object.values(tpl.bodies || {}).join('\n');
    const vals: Record<string, string> = {};
    for (const ph of tpl.placeholders) vals[ph] = '';
    vals.__TEMPLATE_BODY__ = tplOf(ID).body;
    vals.__GENERATED_BODY__ = FROZEN.body;
    vals.__PROMPT_ID__ = ID;
    const out = enginePrompt.substituteOnce(body, Object.keys(vals), vals);
    expect(out).not.toContain('__GENERATED_BODY__');
    expect(out).toContain('a Toast component at cx-shared\n__PROMPT_ROLE__');
    expect(out).toContain('is to __PROMPT_ROLE__.');
    expect(out).toMatch(/narrowed to one (story|call)/i);
    expect(out).toMatch(/slot[^.]*no longer (fits|reads)/i);
    expect(contract.outputFieldsIn(body), 'the reviewer\'s answer shape changed').toEqual(['falseClaims']);
  });
});
