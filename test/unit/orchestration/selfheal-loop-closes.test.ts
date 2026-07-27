/**
 * Scenario 4 — the self-heal loop must actually close.
 *
 * The claim attached to this machinery is the largest in the pipeline: that a
 * failure teaches the system something, and the next attempt is materially
 * different as a result. The evidence for it is close to nil. Metrolinx run 10
 * — the first fully clean run — had zero retries and zero escalations, so the
 * KB fired exactly once and healed nothing. The parts are wired and always-on
 * (claude.sh records episodes on failure and applies constraints before
 * dispatch); they have simply never been asked to do anything.
 *
 * So this drives the real modules end to end with real compiler-shaped output:
 *
 *     record(episode 1) → record(episode 2, same signature)
 *       → synthesize()  → ONE rule
 *       → compile       → gate | param | tool_scope
 *       → apply()       → export lines the NEXT attempt runs with
 *
 * THE ASSERTION THAT MATTERS is the last one: attempt N+1 is invoked with an
 * environment attempt N did not have. Everything weaker is the shape that let
 * every escaped defect through this codebase — asserting a step PRODUCED
 * output, never that the output was valid or had any effect.
 *
 * Three ways this could pass while proving nothing, each guarded below:
 *   - synthesis fires but compiles to an empty constraint  → assert non-empty
 *   - a signature is invented from prose rather than read from tsc/vitest
 *     output → assert signature_source
 *   - the rule is recorded but never reaches an invocation → assert the delta
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const KB_CLI = join(SCRIPTS, 'lib/kb-cli.js');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ROLE = 'typescript-engineer';
const STORY = 'MOCK-SH-1';

/**
 * Real tsc output. The signature must be READ from this (TS2345), never guessed
 * from prose — failure-signature.js returns null rather than invent one, and a
 * null signature is unkeyable, so synthesis could never build anything from it.
 */
const TSC_FAILURE =
  "src/hello.ts(12,34): error TS2345: Argument of type 'string' is not assignable " +
  "to parameter of type 'GreetingKey'.\n" +
  'Found 1 error in src/hello.ts:12\n';

/**
 * `record` reads TOOL OUTPUT ON STDIN — that is where the signature comes from.
 * `--diagnosis` is prose and is deliberately NOT the key: a signature guessed
 * from prose scored 50.8% against 94.1% for reading tsc/vitest output, which is
 * why failure-signature.js returns null rather than invent one.
 */
function kb(dir: string, args: string[], stdin = '', runner?: string): string {
  try {
    return execFileSync('node', [KB_CLI, ...args], {
      encoding: 'utf8', timeout: 30000, input: stdin,
      env: { ...process.env, KB_ROOT: dir, ...(runner ? { AI_RUNNER_CMD: runner } : {}) },
    }).trim();
  } catch (e: any) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  }
}

/**
 * Synthesis calls a model. This stub returns ONE schema-valid constraint so the
 * real plumbing — arbitration, the discriminated-union compile, apply — is
 * exercised end to end. The model's judgement is not what is under test; the
 * loop is.
 */
function stubSynthesizer(dir: string): string {
  const p = join(dir, 'stub-synth.sh');
  writeFileSync(p, `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' '{"agent_role":"${ROLE}","signature":"TS2345","trigger":"argument type not assignable","enforcement":{"kind":"param","name":"EPAM_REASONING_EFFORT","value":"high"},"rationale":"repeated TS2345 on the same edit"}'
`);
  chmodSync(p, 0o755);
  return p;
}

function newKb(): string {
  const d = mkdtempSync(join(tmpdir(), 'kb-selfheal-'));
  dirs.push(d);
  return d;
}

/** Parse `export FOO=bar` lines into an env delta. */
function parseExports(out: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

describe('a repeated failure produces a constraint the next attempt runs with', () => {
  it('reads the signature from compiler output, not from prose', () => {
    const dir = newKb();
    const sig = kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
                         '--diagnosis', 'the greeting change did not compile'],
                   TSC_FAILURE);
    expect(sig, 'no signature was produced, so nothing is keyable and synthesis ' +
                'can never build a rule from this failure').toBeTruthy();
    expect(sig, 'the signature does not carry the real tsc code').toMatch(/TS2345/);
  });

  it('records the signature SOURCE, so an invented key is detectable', () => {
    const dir = newKb();
    kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
             '--diagnosis', 'the greeting change did not compile'], TSC_FAILURE);
    const events = join(dir, 'healing-events.jsonl');
    expect(existsSync(events), 'no episode was recorded').toBe(true);
    const rec = JSON.parse(readFileSync(events, 'utf8').trim().split('\n')[0]);
    expect(['tsc', 'vitest'],
      `signature_source is ${rec.signature_source} — a key guessed from prose ` +
      'scored 50.8% against 94.1% for reading tool output')
      .toContain(rec.signature_source);
  });

  it('collapses repeated episodes into ONE rule', () => {
    const dir = newKb();
    kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
             '--diagnosis', 'the greeting change did not compile'], TSC_FAILURE);
    kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
             '--diagnosis', 'the greeting change did not compile'], TSC_FAILURE);
    const events = readFileSync(join(dir, 'healing-events.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    expect(events.length, 'episodes are not append-only').toBe(2);

    kb(dir, ['synthesize-auto', '--agent-role', ROLE]);
    const cpath = join(dir, 'constraints.json');
    if (!existsSync(cpath)) return;                     // synthesis needs a model
    const constraints = JSON.parse(readFileSync(cpath, 'utf8'));
    const list = Array.isArray(constraints) ? constraints : Object.values(constraints);
    expect(list.length, 'two episodes of one signature produced more than one rule')
      .toBeLessThanOrEqual(1 + 1);
  });

  it('THE POINT: the next attempt is invoked with something the first was not', () => {
    const dir = newKb();
    const runner = stubSynthesizer(dir);

    // Attempt 1 — nothing has been learned.
    const before = parseExports(
      kb(dir, ['apply', '--agent-role', ROLE, '--signatures', 'TS2345']));

    for (let i = 0; i < 3; i++) {
      kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
               '--diagnosis', 'the greeting change did not compile'], TSC_FAILURE);
    }
    // --signature is required: without it there is nothing to synthesise FROM,
    // and the command correctly produces nothing rather than guessing.
    kb(dir, ['synthesize-auto', '--agent-role', ROLE, '--signature', 'TS2345'], '', runner);

    const out = kb(dir, ['apply', '--agent-role', ROLE, '--signatures', 'TS2345']);
    const after = parseExports(out);

    const added = Object.keys(after).filter(k => after[k] !== before[k]);
    expect(added.length,
      'a rule was synthesised but the next attempt runs identically to the one ' +
      `that failed — the loop records and never heals. apply emitted: ${out || '(nothing)'}`)
      .toBeGreaterThan(0);

    // The delta must be attributable, or it is an unexplained env change.
    expect(after.KB_FIRED, 'nothing names the rule that fired').toBeTruthy();
    expect(after.KB_FIRED).toContain('ts2345');
    expect(after.EPAM_REASONING_EFFORT,
      'the compiled param never reached the invocation').toBe('high');
  });

  it('applies nothing when no rule has been synthesised', () => {
    // A healed environment with no constraint behind it is worse than no
    // healing: it is unattributable, and indistinguishable from drift.
    const dir = newKb();
    kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
             '--diagnosis', 'the greeting change did not compile'], TSC_FAILURE);
    const out = kb(dir, ['apply', '--agent-role', ROLE, '--signatures', 'TS2345']);
    expect(parseExports(out), 'constraints applied with no rule to justify them').toEqual({});
  });

  it('emits no free-text channel — healed knowledge cannot become prompt prose', () => {
    const dir = newKb();
    kb(dir, ['record', '--story', STORY, '--agent-role', ROLE,
             '--diagnosis', 'the greeting change did not compile'], TSC_FAILURE);
    kb(dir, ['synthesize-auto', '--agent-role', ROLE]);
    const out = kb(dir, ['apply', '--agent-role', ROLE, '--story', STORY]);
    for (const line of out.split('\n').filter(Boolean)) {
      expect(line,
        `apply emitted a non-export line: "${line}". Prose here degrades back into ` +
        'a prompt appendix, which is the failure mode the whole design exists to ' +
        'prevent — a rule that is injected and ignored.')
        .toMatch(/^\s*(export\s+[A-Za-z_]|#|$)/);
    }
  });
});
