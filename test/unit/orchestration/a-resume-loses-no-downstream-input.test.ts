/**
 * NO INPUT A LATER AGENT NEEDS MAY BE LOST BY RESUMING.
 *
 * Pause 1 and pause 2 are HUMAN REVIEW POINTS INSIDE A RUN. The run stops, a person looks at what
 * the earlier stages produced, and the run RESUMES. That is only coherent if resuming preserves
 * every input the later stages are waiting for.
 *
 * It did not. pre-run-reset.sh deleted estate-survey.json — read back by surveyHypothesisBlock and
 * injected into code-graph-detective — and worked out whether this was a resume ~190 lines later,
 * so the deletion could never see it. The survey was paid for, shown to the operator at the pause,
 * and destroyed by the act of continuing.
 *
 * WHY THIS IS A SCANNER AND NOT A LIST. The registry's own `consumes` declarations are incomplete:
 * role-assignments, codeline-selection and topology all declare NO consumer while being read by
 * the orchestrator, and estate-survey declares only survey-review while code-graph-detective reads
 * it too. An audit driven by those declarations would certify a pipeline that loses inputs. So the
 * subject is DISCOVERED from the source: what the pipeline WRITES into LOG_DIR, and what it READS
 * back out. Anything in both sets is carried run state, and a resume must keep it — including
 * artefacts added long after this test was written.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const RESET = join(SCRIPTS, 'pre-run-reset.sh');

/** Every .js/.sh under orchestrations/scripts, so the scan sees the whole pipeline. */
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (/\.(js|sh)$/.test(e)) acc.push(p);
  }
  return acc;
}
const SRC = sources(SCRIPTS).map((f) => ({ f, text: readFileSync(f, 'utf8') }));

/** Artefacts the pipeline writes into its log directory. */
function written(): Set<string> {
  const out = new Set<string>();
  const re = /path\.join\(\s*(?:logDir|LOG_DIR|_logDir)\b[^)]*?['"]([A-Za-z0-9._-]+\.(?:json|jsonl|md|txt))['"]/g;
  for (const { text } of SRC) {
    for (const m of text.matchAll(re)) out.add(m[1]);
  }
  return out;
}

/**
 * Of those, the ones something READS BACK — i.e. a later step depends on them.
 *
 * A read is any reference from a file that is NOT the one that wrote it. Matching read verbs
 * (readFileSync, cat, jq) missed the shell side entirely — role-assignments.json is read by
 * run-agent-orchestration.sh and referenced-docs.json by the mint, and both were scored as
 * write-only, which is exactly the blind spot that let the survey be deleted. If a second file
 * names the artefact at all, something downstream is depending on it.
 */
function readBack(candidates: Set<string>): string[] {
  const kept: string[] = [];
  for (const name of candidates) {
    const esc = name.replace(/\./g, '\\.');
    const writeRe = new RegExp(String.raw`path\.join\(\s*(?:logDir|LOG_DIR|_logDir)\b[^)]*?['"]${esc}['"]`);
    const mentions = SRC.filter(({ text }) => text.includes(name));
    const writers = mentions.filter(({ text }) => writeRe.test(text));
    // referenced somewhere other than where it is produced
    if (mentions.length > writers.length || mentions.length > 1) kept.push(name);
  }
  return kept.sort();
}

const WRITTEN = written();
const CARRIED = readBack(WRITTEN);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Seed every carried artefact, run the REAL reset, report which survived. */
function reset(env: Record<string, string>): { survived: string[]; missing: string[]; out: string } {
  const d = mkdtempSync(join(tmpdir(), 'resume-inputs-')); dirs.push(d);
  const agents = join(d, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'profiles.json'), '{"profiles":[]}\n');
  writeFileSync(join(agents, 'profiles.json.original'), '{"profiles":[]}\n');
  const logDir = join(d, 'logs');
  mkdirSync(logDir, { recursive: true });
  for (const f of CARRIED) writeFileSync(join(logDir, f), '{"producedBy":"the run being resumed"}');

  const r = spawnSync('bash', [RESET, '--prd', join(d, 'no-such-prd.json'), '--log-dir', logDir], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      EPAM_AGENTS_DIR: agents,
      COMPOSE_OVERRIDE: join(d, 'compose-override.yml'),
      DASHBOARD_STATE_DIR: d,
      ...env,
    },
  });
  const survived = CARRIED.filter((f) => existsSync(join(logDir, f)));
  return { survived, missing: CARRIED.filter((f) => !survived.includes(f)), out: (r.stdout || '') + (r.stderr || '') };
}

describe('the scan found a real pipeline to audit', () => {
  it('discovers artefacts the pipeline writes into LOG_DIR', () => {
    // Guards every case below from passing vacuously on an empty scan.
    expect(WRITTEN.size, 'the write scan found nothing — the audit would prove nothing')
      .toBeGreaterThan(5);
  });

  it('and identifies which of them a later step reads back', () => {
    expect(CARRIED.length, 'no artefact appears to be read back — the read scan is broken')
      .toBeGreaterThan(0);
    // The one this defect was found on must be in the set, whatever else is.
    expect(CARRIED).toContain('estate-survey.json');
  });
});

describe('RESUMING FROM A PAUSE LOSES NO INPUT A LATER AGENT NEEDS', () => {
  it('every carried artefact survives EPAM_RESUME_RUN', () => {
    const { missing } = reset({ EPAM_RESUME_RUN: '20260827T213033Z' });
    expect(missing,
      'resuming deleted run state that a later step reads back, so the agent consuming it '
      + 'resumes blind and rediscovers what was already produced and paid for')
      .toEqual([]);
  });
});

describe('and a FRESH run still clears what would contaminate it', () => {
  it('without EPAM_RESUME_RUN the carried state is not silently inherited', () => {
    // The deletion exists for a real reason: a stale survey matched by codeline name (api, web,
    // src) fed one project's evidence into another's prompts. A fresh run must not keep it.
    const { survived } = reset({});
    expect(survived, 'a fresh run inherited a previous run\'s state — the leak is back')
      .not.toContain('estate-survey.json');
  });

  it('a fresh run that merely SKIPS THE MINT is still a fresh run', () => {
    const { survived } = reset({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(survived).not.toContain('estate-survey.json');
  });
});
