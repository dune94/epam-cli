/**
 * THE TC WRITER'S ANSWER SURVIVES ITS OWN LOG.
 *
 * lib/tc-writer-gate.sh runs post-impl-tc-writer.sh `2>&1 | tee -a $LOG_DIR/tc-writer-<phase>.log`, and
 * the script itself ran the model `2>&1 | tee <the same file>` — a TRUNCATING tee — then extracted the
 * answer from that file. Two writers, one appending and one writing from offset 0 after truncating:
 * the answer landed in the file twice, the first copy cut short (".gitigno"), and the extractor judged a
 * correct answer "no JSON". Found 2026-09-27 in the copilot-set greenfield rehearsal: the scaffold TC
 * writer failed three times on three good answers; core passed by timing alone.
 *
 * Executed: the REAL post-impl-tc-writer.sh, in a copy of the engine tree, called exactly the way the
 * gate calls it, with a stand-in hub (EPAM_LLM_HUB) that answers in chunks, with stderr between them —
 * as a model call does. Asserted on what the pipeline produced: the extracted answer and the PRD.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const ROOT = join(__dirname, '../../../');
const STORY = 'T-001';
const FACTS = Array.from({ length: 40 }, (_, i) => `fact ${i}: the slug of input ${i} is lower-case and hyphenated`);

let d = '';
beforeAll(() => {
  d = mkdtempSync(join(tmpdir(), 'tc-log-race-'));
  const orch = join(d, 'orchestrations');
  for (const sub of ['agents', 'prompts', 'config']) cpSync(join(ROOT, 'orchestrations', sub), join(orch, sub), { recursive: true });
  cpSync(join(ROOT, 'orchestrations/scripts'), join(orch, 'scripts'), {
    recursive: true,
    filter: (src) => !/\/orchestrations\/scripts\/(tools|node_modules)(\/|$)/.test(src),
  });
  mkdirSync(join(orch, 'logs'), { recursive: true });
  // The stand-in hub: reads its prompt, then answers the way a model call reaches stdout — in pieces,
  // with the handler's own progress on stderr in between.
  writeFileSync(join(d, 'answer.json'), JSON.stringify({ [STORY]: { facts: FACTS } }, null, 2) + '\n');
  writeFileSync(join(d, 'hub.sh'), [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    `a=${JSON.stringify(join(d, 'answer.json'))}; n=$(wc -c < "$a"); i=0`,
    'for ((o = 0; o < n; o += 200)); do tail -c +$((o + 1)) "$a" | head -c 200; echo "[hub] progress $i" >&2; i=$((i + 1)); sleep 0.02; done',
  ].join('\n'), { mode: 0o755 });
  const app = join(d, 'app'); mkdirSync(join(app, 'src/proof'), { recursive: true }); mkdirSync(join(app, 'tests'));
  writeFileSync(join(app, 'src/proof/slug.py'), 'def slug(s):\n    return s.lower().replace(" ", "-")\n');
});
afterAll(() => { if (d) rmSync(d, { recursive: true, force: true }); });

function freshPrd() {
  writeFileSync(join(d, 'prd.json'), JSON.stringify({
    implementationOrder: { scaffold: ['I-001', STORY] },
    stories: [
      { id: 'I-001', title: 'slug', status: 'completed', technicalNotes: { files: ['src/proof/slug.py'] } },
      { id: STORY, title: 'slug tests', status: 'pending', technicalNotes: { files: ['tests/test_slug.py'] }, dependsOn: ['I-001'] },
    ],
  }, null, 2));
}
const envFor = (orch: string) => ({ ...process.env, EPAM_LLM_HUB: join(d, 'hub.sh'), EPAM_ORCHESTRATION_PROVIDER: 'stand-in', EPAM_MODEL: 'stand-in', EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), LOG_DIR: join(orch, 'logs'), PROJECT_ROOT: join(d, 'app') });

function runAsTheGateDoes() {
  const orch = join(d, 'orchestrations');
  const log = join(orch, 'logs/tc-writer-scaffold.log');
  writeFileSync(log, '');
  freshPrd();
  const script = `bash ${JSON.stringify(join(orch, 'scripts/post-impl-tc-writer.sh'))} --prd ${JSON.stringify(join(d, 'prd.json'))} --phase scaffold --output-dir ${JSON.stringify(join(d, 'app'))} --story ${STORY} 2>&1 | tee -a ${JSON.stringify(log)}; exit \${PIPESTATUS[0]}`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 120_000,
    env: envFor(orch),
  });
  return { ...r, log: readFileSync(log, 'utf8'), out: join(orch, 'logs/tc-scaffold.json') };
}

describe('the TC writer, called the way the gate calls it', () => {
  it('extracts the whole answer and applies it — the shared log does not clobber it', () => {
    const r = runAsTheGateDoes();
    // Not vacuous: the stand-in was reached and answered.
    expect(r.stdout, r.stderr).toContain('[hub] progress 0');
    expect(existsSync(r.out), `${r.stdout}\n${r.stderr}`).toBe(true);
    expect(JSON.parse(readFileSync(r.out, 'utf8'))[STORY].facts).toEqual(FACTS);
    const prd = JSON.parse(readFileSync(join(d, 'prd.json'), 'utf8'));
    expect(prd.stories.find((s: { id: string }) => s.id === STORY).testCriteria.facts).toEqual(FACTS);
  });

  it('the shared log keeps what the gate wrote before the call — it is appended to, never truncated', () => {
    const r = runAsTheGateDoes();
    expect(r.log).toMatch(/\[tc-writer\] Phase 'scaffold': 1 test story/);
    expect(r.log).toContain(`"${STORY}"`);
  });
});

/** The orchestrator's batch call, lifted from run-agent-orchestration.sh itself and executed. */
function runAsTheOrchestratorDoes(previousAttempt: string) {
  const orch = join(d, 'orchestrations');
  const log = join(orch, 'logs/tc-writer-scaffold.log');
  writeFileSync(log, previousAttempt);
  freshPrd();
  const src = readFileSync(join(orch, 'scripts/run-agent-orchestration.sh'), 'utf8');
  const start = src.indexOf(': > "$LOG_DIR/tc-writer-${PHASE}.log"');
  const end = src.indexOf('_tc_writer_exit=${PIPESTATUS[0]}', start);
  expect(start, 'the orchestrator\'s TC batch call was not found').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end + '_tc_writer_exit=${PIPESTATUS[0]}'.length);
  const r = spawnSync('bash', ['-c', `${block}\nexit $_tc_writer_exit`], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...envFor(orch), SCRIPT_DIR: join(orch, 'scripts'), PRD_FILE: join(d, 'prd.json'), PHASE: 'scaffold', OUTPUT_DIR: join(d, 'app') },
  });
  return { ...r, log: readFileSync(log, 'utf8'), out: join(orch, 'logs/tc-scaffold.json') };
}

describe('the TC writer, called the way the orchestrator\'s batch step calls it', () => {
  it('extracts the whole answer, and the log holds this attempt only', () => {
    const r = runAsTheOrchestratorDoes('reached maximum iterations — the PREVIOUS attempt\n');
    expect(r.stdout, r.stderr).toContain('[hub] progress 0');
    expect(JSON.parse(readFileSync(r.out, 'utf8'))[STORY].facts).toEqual(FACTS);
    expect(r.log).toMatch(/\[tc-writer\] Phase 'scaffold': 1 test story/);
    // The classifier after this call greps the log for this attempt's failure: the last attempt's
    // text must not be there to be found.
    expect(r.log).not.toContain('the PREVIOUS attempt');
    // And the log is readable: every piece the model wrote is in it whole, not overwritten by a
    // second writer at its own offset.
    const answer = readFileSync(join(d, 'answer.json'), 'utf8');
    for (let o = 0; o < answer.length; o += 200) expect(r.log).toContain(answer.slice(o, o + 200));
  });
});

/**
 * AND IT RETURNS WHEN THE CALL RETURNS. The handler's watchdog leaves an orphaned `sleep` of the
 * seam's full timeout behind (lib: llm-handler.sh _ai_attempt_timeout), its output silenced. The
 * first version of this fix captured stderr with a process substitution, whose pipe that orphan
 * inherited — so the gate's tee waited out the whole timeout after every call: 14 minutes per TC
 * attempt in the £0 greenfield run of 2026-09-28, which timed escalation-chain out.
 */
describe('the TC writer does not outlive its call', () => {
  it('a background child the handler leaves behind does not hold the gate open', () => {
    const hub = join(d, 'hub.sh');
    const original = readFileSync(hub, 'utf8');
    writeFileSync(hub, `${original}\n( sleep 20 >/dev/null 2>&1 & )\n`, { mode: 0o755 });
    try {
      const t0 = Date.now();
      const r = runAsTheGateDoes();
      const secs = (Date.now() - t0) / 1000;
      expect(JSON.parse(readFileSync(r.out, 'utf8'))[STORY].facts).toEqual(FACTS);
      expect(secs, 'the gate waited for the orphan, not for the call').toBeLessThan(15);
    } finally { writeFileSync(hub, original, { mode: 0o755 }); }
  }, 60_000);
});
