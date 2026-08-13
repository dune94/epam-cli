/**
 * THE WRITER IS TOLD WHAT ITS LAST ATTEMPT DID — ON EVERY RETRY, NOT ONLY IN-PROCESS ONES.
 *
 * WRITTEN BEFORE THE FIX. This is TESTING-FAILURES.md TF-1.
 *
 * The requirement, in the words it was given:
 *
 *     "make sure the 'what you did on the last try' input is provided to the writer"
 *
 * What shipped was gated on `_total_attempts`, a variable local to `implement_story` and
 * incremented once per in-process retry. The review cycle re-invokes the writer as a NEW PROCESS
 * (run-agent-orchestration.sh:8269), where the counter starts at zero — so the writer fixing its
 * own work, the case the requirement was about, never received it.
 *
 * The original test asserted what `_attempt_change_summary` RETURNS. It passed, and still passes,
 * and proved nothing about delivery. So this file follows the rule that failure produced:
 *
 *     TEST THE REQUIREMENT'S ACTOR, IN THE SITUATION THE REQUIREMENT NAMES.
 *
 * The actor is the WRITER and the situation is a RETRY, so every test here renders a real writer
 * prompt and asserts on its bytes. The harness renders in a fresh process by construction, which
 * is exactly the review-cycle condition — a counter-gated implementation cannot pass these.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { renderWriterPrompt, cleanupWriterPromptFixtures } from '../../helpers/writer-prompt';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const io = require(join(ROOT, 'orchestrations/scripts/lib/agent-io.js'));

afterAll(cleanupWriterPromptFixtures);

const story = (id: string) => ({
  id,
  title: 'render live content',
  description: 'the page must refetch when the editor publishes',
  acceptanceCriteria: ['the response is not cached'],
  technicalNotes: { files: ['src/service.ts'] },
});

const base = {
  env: { EPAM_BROWNFIELD: '1' },
  projectFiles: { 'src/service.ts': 'export const a = 1;\n' },
};

/** Render the writer prompt with attempt evidence already published, as the engine publishes it. */
function withEvidence(id: string, evidence: string) {
  return renderWriterPrompt({
    story: story(id),
    ...base,
    publish: [{ from: 'engine', kind: 'attempt-evidence', content: evidence }],
  });
}

describe('THE WRITER RECEIVES IT — THE ACTOR AND SITUATION THE REQUIREMENT NAMED', () => {
  it('a retry prompt carries what the last attempt did', () => {
    const r = withEvidence('TF1-1', ' src/service.ts | 12 ++++++--\n 1 file changed');
    expect(r.rc, r.stderr).toBe(0);
    expect(r.text, 'the writer was not told what its last attempt did')
      .toContain('src/service.ts | 12 ++++++--');
  });

  it('it arrives in a FRESH PROCESS with no in-process retry — the review-cycle case', () => {
    // THE DEFECT. The review cycle re-invokes the writer as a new process, where any per-process
    // attempt counter reads zero. Delivery must depend on the evidence existing, not on a counter.
    // This harness always renders in a fresh process, so a counter-gated implementation fails here.
    const r = withEvidence('TF1-2', 'FRESH-PROCESS-EVIDENCE');
    expect(r.rc, r.stderr).toBe(0);
    expect(r.text, 'a new-process retry did not receive the evidence — the review-cycle gap')
      .toContain('FRESH-PROCESS-EVIDENCE');
  });

  it('it is framed as evidence, not as an instruction', () => {
    // The archetype declares authority "evidence, not instruction". A diffstat read as a demand is
    // how a writer talks itself into re-doing work it already did.
    const r = withEvidence('TF1-3', 'DIFFSTAT-BODY');
    expect(r.text.toLowerCase()).toMatch(/diffstat|not a judgement|evidence/);
  });

  it('it says WHO produced it', () => {
    const r = withEvidence('TF1-4', 'DIFFSTAT-BODY');
    expect(r.text).toMatch(/engine/i);
  });
});

describe('NOTHING TO SAY MEANS NOTHING IS SAID', () => {
  it('a first attempt, with no evidence published, carries no section', () => {
    const r = renderWriterPrompt({ story: story('TF1-5'), ...base });
    expect(r.rc, r.stderr).toBe(0);
    expect(r.text, 'a first attempt was told what a previous attempt did')
      .not.toMatch(/attempt-evidence|What Your Last Attempt Did/i);
  });

  it('evidence that is published EMPTY clears it rather than rendering a blank section', () => {
    const r = withEvidence('TF1-6', '');
    expect(r.rc, r.stderr).toBe(0);
    expect(r.text).not.toMatch(/attempt-evidence/i);
  });
});

describe('DELIVERY IS NOT GATED ON PROCESS-LOCAL STATE', () => {
  it('claude.sh no longer decides delivery from an attempt counter', () => {
    // The specific defect: `[ "$_total_attempts" -gt 1 ]` guarding the section. Delivery now
    // follows publication, which survives a new process; a counter does not.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('node:fs')
      .readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const at = src.indexOf('What Your Last Attempt Did');
    expect(at, 'the hand-rendered attempt section is still in the prompt builder').toBe(-1);
  });

  it('the engine publishes the evidence, so every consumer that declares it gets it', () => {
    // The reviewer declares attempt-evidence too. One publication, every declared consumer —
    // that is the point of the framework, and it is why this cannot regress per-consumer.
    const reg = JSON.parse(require('node:fs')
      .readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    const consumers = Object.entries<any>(reg.profiles)
      .filter(([, p]) => (p.consumes || []).some((c: any) => c.kind === 'attempt-evidence'))
      .map(([n]) => n);
    expect(consumers.length, 'nothing declares attempt-evidence').toBeGreaterThan(1);
    expect(reg.engineProduces).toContain('attempt-evidence');
  });
});

describe('THE ENGINE PUBLISHES WHAT IS ACTUALLY ON DISK', () => {
  it('the diffstat producer is deterministic and model-free', () => {
    // It is git output, not an opinion. A model summarising the diff would be a second source of
    // truth about what is already on disk.
    const src = require('node:fs')
      .readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const at = src.indexOf('_attempt_change_summary()');
    expect(at, 'the diffstat producer is gone').toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body, 'the summary asks a model what changed').not.toMatch(/ai-run|invoke_agent|claude/);
    expect(body).toMatch(/git/);
  });

  it('publication reaches the store the consumer reads', () => {
    // The cross-language seam: the shell publishes, the JavaScript consumer collects.
    const dir = require('node:fs').mkdtempSync(join(require('node:os').tmpdir(), 'tf1-'));
    const env = { AGENT_IO_DIR: join(dir, 'io') };
    io.publish('engine', 'attempt-evidence', 'S-1', 'ON-DISK', env);
    expect(io.collect('S-1', ['attempt-evidence'], env)).toContain('ON-DISK');
  });
});

describe('THE ENGINE ITSELF PUBLISHES IT — NOT THE TEST HARNESS', () => {
  // THE REPEAT-RISK. Every test above publishes the evidence itself and then asserts the writer
  // renders it. That is the same shape as the test that produced TF-1: it proves the consumer
  // works and says nothing about whether anything actually publishes in a run. So this executes
  // claude.sh's OWN publication statement, against a real git fixture, and asserts the store.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os');

  function enginePublishes(makeChange: boolean, priorAttempts = 1): string {
    const dir = mkdtempSync(join(tmpdir(), 'tf1-engine-'));
    const repo = join(dir, 'repo');
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    execFileSync('mkdir', ['-p', repo]);
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'baseline');
    // A real codeline has an origin; the diffstat is taken against origin/<baseline>.
    const originDir = join(dir, 'origin.git');
    execFileSync('git', ['clone', '--quiet', '--bare', repo, originDir]);
    git('remote', 'add', 'origin', originDir);
    git('fetch', '-q', 'origin');
    if (makeChange) writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\nexport const b = 3;\n');

    // The REAL statement from claude.sh, lifted rather than paraphrased, with the real
    // _attempt_change_summary and the real publish_agent_output behind it.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const fnAt = src.indexOf('_attempt_change_summary()');
    const fn = src.slice(fnAt, src.indexOf('\n}', fnAt) + 2);
    // THE WHOLE GUARDED BLOCK, not just the publish line. Lifting the statement alone executed
    // publication unconditionally and made the first-attempt case unfalsifiable — the guard IS
    // the behaviour under test here.
    const blockAt = src.indexOf('# WAS THERE A PREVIOUS ATTEMPT?');
    expect(blockAt, 'claude.sh no longer guards the attempt-evidence publication').toBeGreaterThan(0);
    const endAt = src.indexOf('\n        fi', blockAt);
    expect(endAt, 'the publication guard is no longer a closed block').toBeGreaterThan(blockAt);
    const pubLine = src.slice(blockAt, endAt + '\n        fi'.length)
      .split('\n').map((l: string) => l.replace(/^ {8}/, '')).join('\n')
      .replace(/^\s*local /m, '');   // `local` is only valid inside a function; this runs at top level
    expect(pubLine, 'claude.sh no longer publishes attempt-evidence')
      .toContain('publish_agent_output engine attempt-evidence');

    const store = join(dir, 'io');
    execFileSync('bash', ['-c', `set -uo pipefail
      export AGENT_IO_DIR=${JSON.stringify(store)}
      export NODE_BIN=${JSON.stringify(process.execPath)}
      PROJECT_ROOT=${JSON.stringify(repo)}
      GIT_WORK_ROOT=${JSON.stringify(repo)}
      JIRA_BASELINE_BRANCH=$(git -C ${JSON.stringify(repo)} rev-parse --abbrev-ref HEAD)
      story_id=S-1
      _total_attempts=1
      LOG_DIR=${JSON.stringify(join(dir, 'logs'))}
      mkdir -p "$LOG_DIR"
      log() { :; }; warning() { :; }; error() { :; }; info() { :; }
      read_story_retry_count() { echo ${priorAttempts}; }   # durable across processes
      . ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/agent-io.sh'))}
      ${fn}
      ${pubLine!.trim()}`], { encoding: 'utf8' });

    return io.collect('S-1', ['attempt-evidence'], { AGENT_IO_DIR: store });
  }

  it('a changed working tree is published by the engine, unprompted', () => {
    const out = enginePublishes(true);
    expect(out, 'the engine did not publish what the attempt changed').toContain('a.ts');
    expect(out).toMatch(/engine/i);
  });

  it('a previous attempt that wrote NOTHING is reported in words, not omitted', () => {
    // The case _attempt_change_summary calls the most important one: silence reads as "no
    // information" and the next attempt behaves as though it were the first.
    const out = enginePublishes(false, 1);
    expect(out).toMatch(/changed NO files|nothing was written/i);
  });

  it('a FIRST attempt is told nothing at all — there is no previous attempt to describe', () => {
    // The regression removing the counter would have introduced: publishing unconditionally tells
    // a first attempt that "the previous attempt changed NO files", which is a lie it cannot check.
    expect(enginePublishes(false, 0).trim(),
      'a first attempt was told about a previous attempt that never happened').toBe('');
    expect(enginePublishes(true, 0).trim(),
      'a first attempt was handed a diffstat as though it were a retry').toBe('');
  });
});
