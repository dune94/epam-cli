/**
 * THE MINT MUST BE GIVEN EVIDENCE, OR IT WILL INVENT SOME.
 *
 * Live 2026-08-07, first real mint. It proposed three roles, all briefed on a CMS vendor the
 * codeline does not use. Nothing malfunctioned; it had nothing to go on:
 *
 *   - the tickets said only "CMS" — neither product is named anywhere in them
 *   - `documents: 0 fetched of 2 link(s)` — both vendor documents failed to fetch
 *   - the repo path handed over was the ESTATE ROOT (33 repositories), not a repository,
 *     so "read the codeline before you answer" pointed where the answer is not
 *
 * Meanwhile the codeline's own package.json names the real vendor in its dependencies. That
 * is ground truth about a stack and it cannot be guessed at: a manifest either contains the
 * name or it does not.
 *
 * A path that is not a repository is worse than no path — it reads as evidence and contains
 * none.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** An estate root holding repos — the shape that was mistakenly passed as "the codeline". */
function estate() {
  const root = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(root);
  const repo = join(root, 'the-actual-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    dependencies: { '@somevendor/management': '1.0.0', 'some-framework': '2.0.0' },
    devDependencies: { 'a-test-runner': '3.0.0' },
  }));
  // The project declares WHICH manifest and WHICH keys — the engine names no ecosystem.
  // This is provisioned into every codeline from the project's own config, and is the same
  // file the dependency-contract plugin reads.
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam', 'dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json', manifestKeys: ['dependencies', 'devDependencies'],
  }));
  mkdirSync(join(root, 'another-repo', '.git'), { recursive: true });
  return { root, repo };
}

function capturingRunner(answer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-stack-')); dirs.push(dir);
  const capture = join(dir, 'prompt.txt');
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\ncat <<'A'\n<PROJECT_AGENTS>${answer}</PROJECT_AGENTS>\nA\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], capture, dir };
}

const ANSWER = JSON.stringify({
  proposedAgents: [{ name: 'a-domain-engineer', systemPrompt: 'x'.repeat(200), rationale: 'r' }],
});

describe('the declared stack reaches the proposer', () => {
  it('THE FIX: dependency names from the codeline manifest appear in the prompt', async () => {
    const { repo } = estate();
    const ws = mkdtempSync(join(tmpdir(), 'mint-ws-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);

    delete process.env.SPEC_MODE_PROVIDER;
    await spec.mintProjectAgents({
      promptExec: r,
      tickets: [{ id: 'T-1', title: 'preview drafts in CMS', description: 'generic, names no vendor' }],
      referencedDocs: [],
      declaredDependencies: ['@somevendor/management', 'some-framework', 'a-test-runner'],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: repo,
    });

    const prompt = readFileSync(r.capture, 'utf8');
    expect(
      prompt,
      'the mint had no evidence of which product is in use and invented one',
    ).toContain('@somevendor/management');
    expect(prompt).toContain('some-framework');
  }, 60_000);

  it('the prompt tells it NOT to propose around a product that is not declared', async () => {
    const { repo } = estate();
    const ws = mkdtempSync(join(tmpdir(), 'mint-ws2-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      declaredDependencies: ['@somevendor/management'],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: repo,
    });
    expect(readFileSync(r.capture, 'utf8')).toMatch(/does not appear here|not.*declare/i);
  }, 60_000);

  it('with no dependencies the block is absent — it never invites inference from nothing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-ws3-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    expect(readFileSync(r.capture, 'utf8')).not.toMatch(/DECLARES IT DEPENDS ON/);
  }, 60_000);
});

describe('the step resolves a REPOSITORY, not the estate root', () => {
  const step = require('../../orchestrations/scripts/mint-agents-step.js');
  const helpers = (arg: string) => ({
    declaredDependencies: step.declaredDependencies,
    resolveRepoPath: (prd: any, stories: any[]) => step.resolveRepoPath(prd, stories, arg),
  });

  it('a manifest is read into a dependency list', () => {
    const { repo } = estate();
    const deps = helpers('').declaredDependencies(repo);
    expect(deps).toContain('@somevendor/management');
    expect(deps).toContain('a-test-runner');
  });

  it('a codeline that declares no manifest config yields nothing — the engine does not guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-cfg-')); dirs.push(dir);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { x: '1' } }));
    expect(
      helpers('').declaredDependencies(dir),
      'the engine guessed a manifest filename — that is stack knowledge in generic code',
    ).toEqual([]);
  });

  it('an estate root yields no dependencies — it is not a repository', () => {
    const { root } = estate();
    expect(
      helpers('').declaredDependencies(root),
      'the estate root read as if it were the codeline',
    ).toEqual([]);
  });

  it('the PRD outputDir is used when the passed path is not a repository', () => {
    const { root, repo } = estate();
    const resolved = helpers(root).resolveRepoPath({ project: { outputDir: repo } }, []);
    expect(
      resolved,
      'the estate root was accepted as the codeline — this is the live defect',
    ).toBe(repo);
  });

  it('a real repository passed explicitly is honoured', () => {
    const { repo } = estate();
    expect(helpers(repo).resolveRepoPath({}, [])).toBe(repo);
  });

  it('nothing resolvable yields empty, not a wrong path', () => {
    expect(helpers('/nonexistent/estate').resolveRepoPath({}, [])).toBe('');
  });
});

describe('a ticket link reaches the proposer even when the fetch failed', () => {
  it('THE LIVE DEFECT: the URL is evidence, and it was dropped when unfetchable', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-links-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r,
      tickets: [{
        id: 'T-1', title: 'preview drafts in CMS', description: 'names no vendor at all',
        ticketLinks: [{ url: 'https://www.somevendor.com/docs/live-preview' }],
      }],
      // Fetch produced nothing — exactly the live case.
      referencedDocs: [],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    expect(
      readFileSync(r.capture, 'utf8'),
      'both linked documents failed to fetch and their URLs — which named the vendor — were discarded',
    ).toContain('somevendor.com');
  }, 60_000);
});

describe('a fetched document reaches the proposer even without agent-made quotes', () => {
  it('THE GAP: quotes are produced by the link agent, which has not run yet', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-docs-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const docFile = join(ws, 'vendor-doc.txt');
    writeFileSync(docFile, 'The SomeVendor SDK exposes livePreviewQuery on the Stack object.');
    const r = capturingRunner(ANSWER);

    await spec.mintProjectAgents({
      promptExec: r,
      tickets: [{ id: 'T-1', title: 'preview drafts in CMS', description: 'names no vendor' }],
      // Exactly what fetchTicketDocuments returns: no `quotes` field at all.
      referencedDocs: [{ url: 'https://vendor.example/docs', fetchStatus: 'fetched', path: docFile }],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });

    expect(
      readFileSync(r.capture, 'utf8'),
      '25KB of vendor documentation was fetched and filtered straight back out',
    ).toContain('livePreviewQuery');
  }, 60_000);

  it('quotes are still preferred when the link agent HAS run', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-quotes-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [{ url: 'https://vendor.example/d', fetchStatus: 'fetched', quotes: ['a chosen quote'] }],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    expect(readFileSync(r.capture, 'utf8')).toContain('a chosen quote');
  }, 60_000);

  it('an unreachable document contributes nothing but does not break the block', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mint-unreach-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [{ url: 'https://vendor.example/gone', fetchStatus: 'unreachable', path: '' }],
      declaredDependencies: [],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    const prompt = readFileSync(r.capture, 'utf8');
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).not.toContain('vendor.example/gone');
  }, 60_000);
});

/**
 * ONE ROSTER, ALL CODELINES (operator direction, 2026-08-07).
 *
 * Ingest discovered three codelines — "No per-story codeline labels; using discovered
 * codelines: gotransit, metrolinx, upexpress" — and the mint saw exactly one, the PRD's
 * outputDir. So the roster was designed against a third of the project, and every brief
 * named that one repository by absolute path: wrong for the other two, and wrong on any
 * other machine.
 */
describe('one roster spans every codeline in scope', () => {
  function multiEstate() {
    const root = mkdtempSync(join(tmpdir(), 'multi-')); dirs.push(root);
    const mk = (name: string, dep: string) => {
      const r = join(root, name);
      mkdirSync(join(r, '.git'), { recursive: true });
      writeFileSync(join(r, 'package.json'), JSON.stringify({ dependencies: { [dep]: '1.0.0' } }));
      mkdirSync(join(r, '.epam'), { recursive: true });
      writeFileSync(join(r, '.epam', 'dependency-check.json'), JSON.stringify({
        manifestFile: 'package.json', manifestKeys: ['dependencies'],
      }));
      return r;
    };
    return { alpha: mk('alpha', 'dep-of-alpha'), beta: mk('beta', 'dep-of-beta') };
  }

  it('every codeline and its stack reaches the proposer', async () => {
    const { alpha, beta } = multiEstate();
    const ws = mkdtempSync(join(tmpdir(), 'multi-ws-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);

    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      codelines: [
        { name: 'alpha', path: alpha, dependencies: ['dep-of-alpha'] },
        { name: 'beta', path: beta, dependencies: ['dep-of-beta'] },
      ],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: alpha,
    });

    const prompt = readFileSync(r.capture, 'utf8');
    expect(prompt).toContain('alpha');
    expect(prompt, 'a codeline in scope was invisible to the mint').toContain('beta');
    expect(prompt).toContain('dep-of-alpha');
    expect(prompt).toContain('dep-of-beta');
    expect(prompt).toMatch(/CODELINES IN SCOPE \(2\)/);
  }, 60_000);

  it('it is told to produce ONE roster, not one per codeline', async () => {
    const { alpha } = multiEstate();
    const ws = mkdtempSync(join(tmpdir(), 'multi-ws2-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      codelines: [{ name: 'alpha', path: alpha, dependencies: [] }],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: alpha,
    });
    const prompt = readFileSync(r.capture, 'utf8');
    expect(prompt).toMatch(/ONE roster/i);
    expect(prompt).toMatch(/near-duplicate roles per codeline/i);
  }, 60_000);

  it('it is told not to bake an absolute path into a brief', async () => {
    const { alpha } = multiEstate();
    const ws = mkdtempSync(join(tmpdir(), 'multi-ws3-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      codelines: [{ name: 'alpha', path: alpha, dependencies: [] }],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: alpha,
    });
    expect(
      readFileSync(r.capture, 'utf8'),
      'briefs baked in one machine\'s absolute path, wrong everywhere else',
    ).toMatch(/Never write an absolute filesystem path/i);
  }, 60_000);

  it('a codeline that declares nothing says so rather than looking equipped', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'multi-ws4-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }], referencedDocs: [],
      codelines: [{ name: 'alpha', path: '/x/alpha', dependencies: [] }],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    expect(readFileSync(r.capture, 'utf8')).toMatch(/no dependency evidence/i);
  }, 60_000);
});

/**
 * AN INSTRUCTION TO READ, GIVEN TO AN AGENT THAT CANNOT READ.
 *
 * The mint ran with NO tools: ai-run.sh forces --no-tools unless AI_GATE_ALLOW_TOOLS=1, and
 * only EPAM_RESPONSE_SCHEMA was passed. So the agent designing the entire roster could not
 * open a single file — while the prompt told it to "read them before you answer". At best
 * that is ignored; at worst it invites the model to narrate an inspection that never happened.
 *
 * Live 2026-08-07: two briefs instructed implementers to set `preview_token` in
 * Contentstack.Stack(). All three codelines pin contentstack ^3.15.3 and the symbol appears
 * nowhere in it. The vendor documentation says it; nothing could check it; the brief asserted
 * it confidently.
 *
 * Read-only by construction — no bash, no write_file. This stage has no story scope.
 */
describe('the mint can actually read what it is told to read', () => {
  async function promptWith(toolGrant?: string) {
    const ws = mkdtempSync(join(tmpdir(), 'mint-tools-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [], declaredDependencies: [], toolGrant,
      codelines: [{ name: 'alpha', path: '/x/alpha', dependencies: [] }],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    return readFileSync(r.capture, 'utf8');
  }

  it('with tools, it is told to VERIFY rather than merely read', async () => {
    const p = await promptWith('read_file,list_files,search,dependency_contract');
    expect(p).toMatch(/READ-ONLY tools/);
    expect(p).toMatch(/dependency_contract/);
    expect(
      p,
      'nothing tells it to check a named API against the installed package',
    ).toMatch(/VERIFY any API or package/i);
    expect(p).toMatch(/the repository wins/i);
  }, 60_000);

  it('with NO tools, it is told so plainly and asked to flag documentation-only claims', async () => {
    const p = await promptWith(undefined);
    expect(
      p,
      'an agent with no tools is still told to read the codelines',
    ).toMatch(/NO tools on this call/);
    expect(p).toMatch(/rests on documentation rather than on this codebase/i);
    expect(p).not.toMatch(/READ-ONLY tools \(/);
  }, 60_000);

  it('the grant is read-only — never bash or write_file', async () => {
    const step = require('../../orchestrations/scripts/mint-agents-step.js');
    const grant = step.mintTools([{ name: 'x', path: '/nonexistent' }]);
    expect(grant.split(',')).toEqual(expect.arrayContaining(['read_file', 'list_files', 'search']));
    expect(grant, 'the roster-design stage can run shell commands').not.toMatch(/\bbash\b/);
    expect(grant, 'the roster-design stage can write files').not.toMatch(/write_file/);
  });
});

/**
 * A CODELINE IS IDENTIFIED BY NAME, NEVER BY POSITION.
 *
 * The brief-writing instruction forbade absolute filesystem paths, and the model complied by
 * referring to codelines as "the repository at the first path in scope", "the second path",
 * "the third". Every brief in the 20260807T183329Z roster did this.
 *
 * Ordinals are order-dependent. If discovery returns the codelines in a different sequence —
 * and nothing guarantees it will not — every brief silently points at a different repository.
 * The sentence still reads correctly, so nothing detects it. A name is the only reference that
 * stays true across runs and across machines.
 */
describe('briefs must name codelines, not number them', () => {
  it('the prompt forbids positional identification', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ordinal-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [], declaredDependencies: [],
      codelines: [
        { name: 'alpha', path: '/x/alpha', dependencies: [] },
        { name: 'beta', path: '/x/beta', dependencies: [] },
      ],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    const p = readFileSync(r.capture, 'utf8');
    expect(p, 'nothing forbids identifying a codeline by position').toMatch(/Never identify a codeline by POSITION/);
    expect(p).toMatch(/order codelines are listed in is not stable/i);
    expect(p, 'it does not say why positional references are undetectable').toMatch(/the\s+sentence\s+still\s+reads\s+correctly/i);
  }, 60_000);

  it('it still forbids absolute paths, and says a name is the stable reference', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ordinal2-')); dirs.push(ws);
    writeFileSync(join(ws, 'profiles.json'), '{}');
    const r = capturingRunner(ANSWER);
    await spec.mintProjectAgents({
      promptExec: r, tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [], declaredDependencies: [],
      codelines: [{ name: 'alpha', path: '/x/alpha', dependencies: [] }],
      profilesPath: join(ws, 'profiles.json'), agentsDir: ws, logDir: ws, repoPath: '',
    });
    const p = readFileSync(r.capture, 'utf8');
    expect(p).toMatch(/Never write an absolute filesystem path/);
    expect(p).toMatch(/A name is the only reference that stays true/i);
  }, 60_000);
});
