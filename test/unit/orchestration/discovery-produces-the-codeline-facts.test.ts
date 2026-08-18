/**
 * DISCOVERY PRODUCES THE CODELINE FACTS.
 *
 * codeline-facts.json is what tells an agent working inside a repository the things it cannot
 * read off the source — that this one's pre-commit hook dies at import time unless four env
 * vars are set, that that one's tests need a live index. The engine splits it per codeline and
 * drops each slice into that worktree's .epam/ so the agents there can see it.
 *
 * NOTHING PRODUCED IT. Every one in the repo was typed by a human into a project directory, and
 * the only code that writes anything is the split that distributes the hand-written file. So a
 * new project had no facts at all, and the knowledge a run acquired died with the run.
 *
 * ONE PRODUCER, NOT TWO. An earlier draft of this had discovery emit structural facts and the
 * detective add operational ones. That is incoherent once facts do not accumulate: two
 * producers writing one file that is rewritten every run means the second silently overwrites
 * the first. Discovery is the stage that scans the whole estate and sees every codeline at
 * once, so it emits them, once, and nothing else writes that file. The detective stays a
 * consumer — it already declares `consumes: codeline-facts`.
 *
 * REGENERATED, NEVER ACCUMULATED. Operator, 2026-08-16: "no it does not accumulate over runs."
 * Each run's file is what this run's discovery found. A fact that survives runs it was never
 * re-observed in is a fact nobody is checking, and the wrong ones would outlive the right ones.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/codeline-discovery.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { writeCodelineFacts } = require(join(ROOT, 'orchestrations/scripts/lib/codeline-facts.js'));

const templateBody = (): string => JSON.parse(readFileSync(TEMPLATE, 'utf8')).body as string;

const CODELINES = [
  {
    name: 'alpha',
    path: '/repos/alpha',
    reason: 'owns the fare rules',
    evidence: 'ticket component "fares"',
    facts: [
      { text: 'Tests require a running index; `npm test` fails at startup without it.', source: 'test/setup.ts' },
    ],
  },
  {
    name: 'beta',
    path: '/repos/beta',
    reason: 'owns the departure board',
    evidence: 'ticket component "board"',
    facts: [{ text: 'The build emits to dist/ and the lint step reads it.', source: 'package.json scripts' }],
  },
];

function project(): string {
  return mkdtempSync(join(tmpdir(), 'codeline-facts-'));
}

describe('the agent is asked for the facts', () => {
  it('the prompt requires facts for every codeline it selects', () => {
    expect(templateBody(), 'the discovery agent is never asked for codeline facts, so it cannot produce any')
      .toMatch(/facts/i);
  });

  it('the output format shows facts in the shape the writer expects', () => {
    // The prompt's worked example IS the contract as far as the model is concerned. A field
    // described in prose and absent from the example is a field that does not get returned.
    const body = templateBody();
    const example = body.slice(body.indexOf('Output format'));
    expect(example, 'facts are described but missing from the output example').toMatch(/"facts"/);
    expect(example, 'a fact carries no text field').toMatch(/"text"/);
    expect(example, 'a fact carries no source, so a wrong one cannot be traced').toMatch(/"source"/);
  });

  it('a fact must be grounded, exactly like a selection must', () => {
    // Discovery already refuses an ungrounded SELECTION — "if you have to say likely, probably,
    // or may be, you do not have evidence". A fact asserted from a hunch is worse: it is handed
    // to every agent working in that repository as though it were established.
    expect(templateBody()).toMatch(/facts?[^.]{0,400}(observed|grounded|verbatim|quote|do not (guess|invent))/is);
  });
});

describe('the facts are written where the engine already reads them', () => {
  it('keys them by codeline NAME at the top level', () => {
    // The engine does `jq '.[$cl]'`. Nesting them one level down — under "codelines", say —
    // yields nothing for every codeline while looking like a populated file.
    const dir = project();
    try {
      writeCodelineFacts({ projectConfigDir: dir, codelines: CODELINES });
      const doc = JSON.parse(readFileSync(join(dir, 'codeline-facts.json'), 'utf8'));
      expect(Object.keys(doc)).toEqual(expect.arrayContaining(['alpha', 'beta']));
      expect(doc.alpha.facts[0].text).toMatch(/running index/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is readable by the exact jq expression the engine uses', () => {
    // Asserting the shape in JS proves the shape I had in mind. The engine reads it with jq,
    // and the file I hand-wrote for mock3 passed every JS-shaped check while returning empty
    // from jq. Run the real expression.
    const dir = project();
    try {
      writeCodelineFacts({ projectConfigDir: dir, codelines: CODELINES });
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const { spawnSync } = require('node:child_process');
      for (const cl of ['alpha', 'beta']) {
        const r = spawnSync('jq', ['-c', '--arg', 'cl', cl, '.[$cl] // empty',
          join(dir, 'codeline-facts.json')], { encoding: 'utf8' });
        expect(r.stdout.trim(), `jq extracts nothing for '${cl}' — the engine would provision no facts`)
          .not.toBe('');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('each run regenerates, and never accumulates', () => {
  it('a codeline absent from this run is GONE, not carried forward', () => {
    // The operator's rule. A fact that outlives the run that observed it is a fact nobody is
    // re-checking, and a wrong one would outlive every right one.
    const dir = project();
    try {
      writeCodelineFacts({ projectConfigDir: dir, codelines: CODELINES });
      writeCodelineFacts({ projectConfigDir: dir, codelines: [CODELINES[0]] });
      const doc = JSON.parse(readFileSync(join(dir, 'codeline-facts.json'), 'utf8'));
      expect(doc.alpha, 'this run\'s codeline was dropped').toBeTruthy();
      expect(doc.beta, 'a previous run\'s codeline survived into this one').toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a changed fact REPLACES the old one rather than joining it', () => {
    const dir = project();
    try {
      writeCodelineFacts({ projectConfigDir: dir, codelines: CODELINES });
      writeCodelineFacts({
        projectConfigDir: dir,
        codelines: [{ ...CODELINES[0], facts: [{ text: 'The index requirement was removed.', source: 'test/setup.ts' }] }],
      });
      const doc = JSON.parse(readFileSync(join(dir, 'codeline-facts.json'), 'utf8'));
      expect(doc.alpha.facts.length, 'the old fact was kept alongside the new one').toBe(1);
      expect(doc.alpha.facts[0].text).toMatch(/removed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('an empty result is visible, not silent', () => {
  it('a codeline the agent gave no facts for is reported', () => {
    // The engine's provisioning step skips quietly when a codeline extracts nothing, so "the
    // agent returned no facts" and "the file is malformed" and "there is no file" all look
    // identical downstream — which is how mock3 would have run with none and said nothing.
    const dir = project();
    const warnings: string[] = [];
    try {
      writeCodelineFacts({
        projectConfigDir: dir,
        codelines: [{ name: 'alpha', path: '/repos/alpha', facts: [] }],
        warn: (m: string) => warnings.push(m),
      });
      expect(warnings.join('\n'), 'a codeline with no facts passed without comment').toMatch(/alpha/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('still writes the codeline, so the file describes every codeline in the run', () => {
    // Omitting it would make "this codeline has no facts" indistinguishable from "this codeline
    // was never discovered".
    const dir = project();
    try {
      writeCodelineFacts({
        projectConfigDir: dir,
        codelines: [{ name: 'alpha', path: '/repos/alpha', facts: [] }],
        warn: () => {},
      });
      const doc = JSON.parse(readFileSync(join(dir, 'codeline-facts.json'), 'utf8'));
      expect(doc.alpha).toBeTruthy();
      expect(doc.alpha.facts).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes nothing at all when there is no project to write to', () => {
    // Guessing a location would provision a project nobody asked for — the same rule the prompt
    // builder follows.
    expect(() => writeCodelineFacts({ projectConfigDir: '', codelines: CODELINES }))
      .toThrow(/projectConfigDir/);
  });
});

describe('THE REAL SCRIPT, end to end', () => {
  // The tests above prove the writer and the prompt in isolation. Neither would catch the thing
  // most likely to go wrong: facts arriving from the agent and being dropped somewhere between
  // the parse, the name derivation, the validation and the ordering. Each of those steps rebuilds
  // or filters the codeline objects, and a field only has to be forgotten once.
  //
  // So this runs the shipped codeline-discovery.js against real git repositories, with only the
  // MODEL stubbed, and looks at the file the engine will actually read.
  it('carries the agent\'s facts all the way to the file the engine reads', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { spawnSync } = require('node:child_process');
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { mkdirSync, chmodSync } = require('node:fs');

    const dir = project();
    try {
      const estate = join(dir, 'estate');
      const repos: Record<string, string> = {};
      for (const name of ['alpharepo', 'betarepo']) {
        const r = join(estate, name);
        mkdirSync(join(r, 'src'), { recursive: true });
        writeFileSync(join(r, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
        writeFileSync(join(r, 'src', 'index.ts'), 'export const x = 1;\n');
        spawnSync('git', ['init', '-q'], { cwd: r });
        spawnSync('git', ['config', 'user.email', 't@t'], { cwd: r });
        spawnSync('git', ['config', 'user.name', 't'], { cwd: r });
        spawnSync('git', ['add', '-A'], { cwd: r });
        spawnSync('git', ['commit', '-qm', 'base'], { cwd: r });
        repos[name] = r;
      }

      // The agent's answer, carrying facts. Emitted regardless of the prompt, because what is
      // under test is what the SCRIPT does with a well-formed reply.
      const reply = JSON.stringify({
        codelines: [
          { name: 'alpharepo', path: repos.alpharepo, reason: 'owns the fares', evidence: 'component "fares"',
            facts: [{ text: 'Tests need a live index before npm test will pass.', source: 'test/setup.ts' }] },
          { name: 'betarepo', path: repos.betarepo, reason: 'owns the board', evidence: 'component "board"',
            facts: [{ text: 'The lint step reads dist/, so it runs after build.', source: 'package.json scripts' }] },
        ],
        unsure: [],
      });
      // TWO AGENTS CALL THIS STUB, and it must tell them apart. Discovery derives a per-ticket
      // vocabulary first, through the same runner, and aborts the whole run if that reply is not
      // tagged — so a stub that answers everything with the codeline JSON never reaches the step
      // under test. It recognises the PROMPT rather than counting calls, because an
      // order-indexed stub answers the wrong question while still looking green.
      const stub = join(dir, 'stub-ai-run.sh');
      writeFileSync(stub, [
        '#!/usr/bin/env bash',
        'PROMPT="$(cat)"',
        'if printf %s "$PROMPT" | grep -q DISCOVERY_VOCABULARY; then',
        '  printf %s "<DISCOVERY_VOCABULARY>{\\"blacklist\\":[{\\"term\\":\\"the\\",\\"reason\\":\\"filler\\"}],\\"whitelist\\":[]}</DISCOVERY_VOCABULARY>"',
        '  exit 0',
        'fi',
        "cat <<'REPLY'",
        reply,
        'REPLY',
      ].join('\n') + '\n');
      chmodSync(stub, 0o755);

      const issues = join(dir, 'issues.json');
      writeFileSync(issues, JSON.stringify([
        { jiraKey: 'MOCK-1', title: 'fares are wrong', description: 'the fare boundary is off', components: ['fares'] },
      ]));

      const r = spawnSync(process.execPath, [
        join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'),
        '--issues', issues, '--root', estate, '--out', join(dir, 'discovery.json'),
      ], {
        encoding: 'utf8',
        timeout: 120000,
        env: {
          ...process.env,
          CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub,
          EPAM_PROJECT_CONFIG_DIR: dir,
          NODE_BIN: process.execPath,
          // What a real run exports from the project's llm-settings.json. Without it the seam's
          // declared POSITION resolves to no tier and the run warns its way through every call.
          EPAM_MODEL_LADDER_TIER_ORDER: 'medium high highest',
          EPAM_MODEL_LADDER_HIGHEST: 'stub-a=stub-b',
        },
      });

      const factsFile = join(dir, 'codeline-facts.json');
      expect(existsSync(factsFile),
        `discovery wrote no codeline facts:\n${(r.stdout || '') + (r.stderr || '')}`.slice(0, 3000),
      ).toBe(true);

      const doc = JSON.parse(readFileSync(factsFile, 'utf8'));
      expect(Object.keys(doc).filter((k) => !k.startsWith('_')).sort()).toEqual(['alpharepo', 'betarepo']);
      expect(doc.alpharepo.facts[0].text, 'the fact was dropped between the agent and the file')
        .toMatch(/live index/);
      expect(doc.alpharepo.facts[0].source, 'the fact lost its source, so it cannot be checked')
        .toMatch(/setup/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the fixtures are honest', () => {
  it('no project ships a hand-written codeline-facts.json in the wrong shape', () => {
    // mock3's was nested under a "codelines" key and returned empty from jq for every codeline.
    // It is the run's output now, so any file that is present must at least be readable the way
    // the engine reads it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { readdirSync } = require('node:fs');
    const base = join(ROOT, 'orchestrations/projects');
    for (const p of readdirSync(base)) {
      const f = join(base, p, 'codeline-facts.json');
      if (!existsSync(f)) continue;
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      const keys = Object.keys(doc).filter((k) => !k.startsWith('_'));
      expect(keys.length, `${p}/codeline-facts.json has no codeline entries at the top level`).toBeGreaterThan(0);
      expect(keys, `${p}/codeline-facts.json nests its codelines, so the engine reads none of them`)
        .not.toContain('codelines');
    }
  });
});
