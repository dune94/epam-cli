/**
 * THREE THINGS A LIVE PAID RUN DISPROVED, each of which had passed in isolation.
 *
 * Run 20260905T011131Z, AMSD-1919, $3.65 before it was killed. Every one of these was "verified"
 * beforehand by a test that exercised the mechanism and not the reality it runs in.
 *
 * ── 1. TOOL-CALL RECORDING LOOKED IN THE WRONG DIRECTORY ─────────────────────────────────────────
 *
 * Nine traces, ZERO carrying toolCalls — the capability recorded nothing. The transcripts existed
 * and were full of calls: roster-specialiser 23, project-roster-review 17 and 10, estate-survey 8.
 * They sat under the CODELINE's transcript directory, because that is where the runner executes
 * (`cd "$PROJECT_ROOT"`), while the matcher derived its directory from the cost emitter's OWN
 * process.cwd() — the install root. It looked in the wrong place on every call.
 *
 * I proved this feature with a synthetic transcript I placed under the cwd myself, which is
 * precisely the assumption that was wrong.
 *
 * ── 2. AN EMPTY `defects_found` BURNED A ROSTER ATTEMPT ──────────────────────────────────────────
 *
 * The reviewer twice answered `defects_found` while listing NO findings. Once that was correctly
 * read as a failed review (retry the judge, leave the artefact alone). The second time it was
 * counted as a rejected ROSTER attempt — consuming one of three and forcing a full rewrite, and
 * roster-specialiser alone costs $1.33 and 7.4 minutes.
 *
 * A verdict that contradicts nothing has not examined anything. It must never implicate the
 * roster, in either code path.
 *
 * ── 3. THE DASHBOARD WAS BLIND FOR THE WHOLE MINT ────────────────────────────────────────────────
 *
 * It showed `stage: starting` for eighteen minutes. step-status.json does not exist until the
 * PHASE begins, and the mint runs before that — so the longest, most expensive stage reports
 * nothing, which is the exact complaint the progress work was meant to answer. The fix covered the
 * phase steps and missed the part that actually goes dark.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TX = join(__dirname, '../../../orchestrations/scripts/lib/transcript-tool-calls.js');
const ROSTER = join(__dirname, '../../../orchestrations/scripts/lib/project-roster.js');
const RUNNER = join(__dirname, '../../../launch-dashboard/backend/src/runner.js');

describe('1. the transcript is looked for where the RUNNER ran, not where the emitter sits', () => {
  const { transcriptDirsToSearch } = require(TX);

  it('the resolver is exported', () => {
    expect(typeof transcriptDirsToSearch,
      'transcriptDirsToSearch is not exported — nothing can look beyond process.cwd()')
      .toBe('function');
  });

  it('includes the directory the runner executes in (PROJECT_ROOT)', () => {
    const dirs = transcriptDirsToSearch(
      { PROJECT_ROOT: '/home/u/codelines/next.gotransit.com' },
      '/home/u/install', '/home/u');
    expect(dirs.join('|'), [
      'the codeline directory is not searched. That is where the runner executes and where every',
      'transcript landed — 23 tool calls for roster-specialiser alone — while the matcher looked',
      'in the install root and found nothing on a live run.',
    ].join('\n')).toMatch(/next-gotransit-com/);
  });

  it('still includes the emitter\'s own cwd — a seam that runs there must keep working', () => {
    const dirs = transcriptDirsToSearch({}, '/home/u/install', '/home/u');
    expect(dirs.join('|')).toMatch(/-home-u-install$/m);
  });

  it('does not search the same directory twice', () => {
    const dirs = transcriptDirsToSearch({ PROJECT_ROOT: '/home/u/install' }, '/home/u/install', '/home/u');
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('THE WIRING: the cost seam finds a transcript under PROJECT_ROOT, with cwd elsewhere', () => {
    // The mutation that reproduces the live defect — searching only process.cwd() — must fail
    // this. Testing transcriptDirsToSearch alone did NOT catch it, which is the same
    // "helper works, wiring does not" trap this whole file exists to record.
    const { toolCallsForThisCall } = require(join(__dirname,
      '../../../orchestrations/scripts/lib/cost-emitter.js'));
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const codeline = join(home, 'codelines', 'next.gotransit.com');
    mkdirSync(codeline, { recursive: true });
    const slug = codeline.replace(/[^A-Za-z0-9]+/g, '-');
    const txDir = join(home, '.claude', 'projects', slug);
    mkdirSync(txDir, { recursive: true });
    const f = join(txDir, 's.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat > roster.json' } }] } }) + '\n');
    const now = Date.now();
    utimesSync(f, new Date(now), new Date(now));

    const prevHome = process.env.HOME; const prevRoot = process.env.PROJECT_ROOT;
    process.env.HOME = home; process.env.PROJECT_ROOT = codeline;
    try {
      const calls = toolCallsForThisCall(
        new Date(now - 3000).toISOString(), new Date(now + 3000).toISOString());
      expect(calls.length, [
        'the cost seam found no calls for a transcript sitting under PROJECT_ROOT. That is the live',
        'defect: the runner does `cd "$PROJECT_ROOT"` and the transcripts land under the CODELINE,',
        'while the seam looked under its own cwd — 9 traces, 0 toolCalls, on a $3.65 run.',
      ].join('\n')).toBe(1);
      expect(calls[0].name).toBe('Bash');
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevRoot === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = prevRoot;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('AMBIGUITY IS STILL REFUSED across the whole search set', () => {
    // Two candidates in one window must still yield nothing, or a cassette replays another
    // agent's action. Widening where we look must not widen what we accept.
    const { transcriptForCall } = require(TX);
    const dir = mkdtempSync(join(tmpdir(), 'tx-multi-'));
    try {
      for (const n of ['a.jsonl', 'b.jsonl']) {
        const p = join(dir, n);
        writeFileSync(p, '{"type":"assistant","message":{"content":[]}}\n');
        utimesSync(p, new Date('2026-09-05T01:12:00Z'), new Date('2026-09-05T01:12:00Z'));
      }
      expect(transcriptForCall(dir, '2026-09-05T01:11:00Z', '2026-09-05T01:13:00Z')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('2. a verdict that names no finding never implicates the roster', () => {
  const { classifyReviewVerdict } = require(ROSTER);

  it('defects_found with NO findings is a failed review, not a rejected roster', () => {
    const v = classifyReviewVerdict({ verdict: 'defects_found', findings: [] });
    expect(v.outcome, [
      'an empty defects_found consumed one of three roster attempts and forced a full rewrite —',
      'roster-specialiser alone is $1.33 and 7.4 minutes. A verdict that contradicts nothing has',
      'examined nothing.',
    ].join('\n')).not.toBe('rejected');
  });

  it('defects_found with NO findings key at all is treated the same way', () => {
    expect(classifyReviewVerdict({ verdict: 'defects_found' }).outcome).not.toBe('rejected');
  });

  it('THE PRODUCER: an empty findings list becomes review_failed, not changes_requested', () => {
    // What rejected the roster on the live run was this translation, not classifyReviewVerdict.
    // DRIVEN, not grepped: the first version of this test searched the source for
    // "!findings.length" and passed even with the guard removed, because that same string also
    // appears in the reason built just below it. A source-text check proved nothing.
    const { rosterReviewVerdict } = require(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));

    const v = rosterReviewVerdict({ verdict: 'defects_found' }, [], []);
    expect(v.verdict, [
      'an empty defects_found still becomes changes_requested, so a review that contradicted',
      'nothing consumes one of three roster attempts and forces a full rewrite —',
      'roster-specialiser alone is $1.33 and 7.4 minutes.',
    ].join('\n')).toBe('review_failed');
    expect(String(v.reason || ''), 'the retry gives no reason a human can act on')
      .toMatch(/listed no findings|contradicted/i);
  });

  it('THE PRODUCER still rejects a roster when a finding is real', () => {
    const { rosterReviewVerdict } = require(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
    const f = [{ agent: 'a-engineer', severity: 'blocking', claim: 'brief is wrong' }];
    expect(rosterReviewVerdict({ verdict: 'defects_found' }, f, f).verdict).toBe('changes_requested');
  });

  it('THE PRODUCER still approves a sound review', () => {
    const { rosterReviewVerdict } = require(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
    expect(rosterReviewVerdict({ verdict: 'sound' }, [], []).verdict).toBe('approved');
  });

  it('a REAL finding still rejects the roster — the guard is not disarmed', () => {
    const v = classifyReviewVerdict({
      verdict: 'defects_found',
      findings: [{ agent: 'a-engineer', severity: 'blocking', claim: 'brief is wrong' }],
    });
    expect(v.outcome, 'a genuine blocking finding must still implicate the roster').toBe('rejected');
    expect(v.findings.length).toBe(1);
  });

  it('an advisory-only finding still approves, as before', () => {
    const v = classifyReviewVerdict({
      verdict: 'defects_found',
      findings: [{ agent: 'a-engineer', severity: 'advisory', claim: 'consider a helper' }],
    });
    expect(v.outcome).toBe('approved');
  });
});

describe('3. the dashboard reports the mint, which runs before any phase step exists', () => {
  const { createRunner } = require(RUNNER);
  const spool = require(join(__dirname, '../../../launch-dashboard/backend/src/spool.js'));

  /** A run in flight with NO step-status.json — the state during the entire mint. */
  function fixture(events: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), 'mint-progress-'));
    const spoolDir = join(dir, 'spool');
    spool.init(spoolDir);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const agentStatus = join(dir, 'logs', 'agent-status.json');
    writeFileSync(agentStatus, JSON.stringify({ phase: null, events }));
    spool.writeRequest(spoolDir, {
      id: 'r1', ticket: 'AMSD-1919', requestedBy: 'op', providerSet: 'claude',
      pauseAfterMint: true, pauseBeforeWriter: true,
    });
    return { dir, spoolDir, agentStatus,
      // step-status.json deliberately absent: that is the whole point.
      stepFile: join(dir, 'logs', 'step-status.json') };
  }

  it('reports the agent that is running, with NO step-status.json present', async () => {
    const f = fixture([
      { type: 'agent_call', message: 'agent-mint · claude-sonnet-5 · 40s' },
      { type: 'agent_call', message: 'roster-specialiser · claude-sonnet-5 · 443s' },
    ]);
    let seen: any = null;
    const runner = createRunner({
      spoolDir: f.spoolDir,
      launcher: async () => {
        await new Promise((r) => setTimeout(r, 120));
        seen = JSON.parse(readFileSync(join(f.spoolDir, 'status', 'r1.json'), 'utf8'));
        return { code: 0, runId: 'run-1' };
      },
      progressFile: f.stepFile,
      progressFallbackFile: f.agentStatus,
      progressMs: 20,
    });
    try {
      await runner.tick();
      expect(seen, 'no status was written at all').toBeTruthy();
      expect(seen.stage, [
        'the dashboard sat on "starting" for the whole mint — eighteen minutes and $3.65 on the',
        'live run — because step-status.json does not exist until the phase begins. The cost seam',
        'was writing agent_call events the whole time and nothing read them.',
      ].join('\n')).not.toBe('starting');
      expect(String(seen.stage)).toContain('roster-specialiser');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('prefers the PHASE step once one exists — the fallback does not outrank it', async () => {
    const f = fixture([{ type: 'agent_call', message: 'roster-specialiser · 443s' }]);
    writeFileSync(f.stepFile, JSON.stringify({ phase: 'core', steps: [
      { id: '5', label: 'Step 5: Regression guard', status: 'running', detail: '' }] }));
    let seen: any = null;
    const runner = createRunner({
      spoolDir: f.spoolDir,
      launcher: async () => {
        await new Promise((r) => setTimeout(r, 120));
        seen = JSON.parse(readFileSync(join(f.spoolDir, 'status', 'r1.json'), 'utf8'));
        return { code: 0 };
      },
      progressFile: f.stepFile, progressFallbackFile: f.agentStatus, progressMs: 20,
    });
    try {
      await runner.tick();
      expect(String(seen.stage)).toMatch(/Regression guard/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('an empty or missing fallback reports nothing rather than inventing', async () => {
    const f = fixture([]);
    let seen: any = null;
    const runner = createRunner({
      spoolDir: f.spoolDir,
      launcher: async () => {
        await new Promise((r) => setTimeout(r, 80));
        seen = JSON.parse(readFileSync(join(f.spoolDir, 'status', 'r1.json'), 'utf8'));
        return { code: 0 };
      },
      progressFile: f.stepFile,
      progressFallbackFile: join(f.dir, 'logs', 'nope.json'),
      progressMs: 20,
    });
    try {
      await runner.tick();
      expect(seen.stage).toBe('starting');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
