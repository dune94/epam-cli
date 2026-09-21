/**
 * A RESUME KEEPS THE RUN'S OWN LEDGERS.
 *
 * pre-run-reset.sh archives and truncates the JSONL ledgers under LOG_DIR on every launch —
 * phase-gates, phase-cost, healing-events, code-reviews, story-failures and the rest. Right for
 * a fresh launch: they are the previous run's. On a RESUME they are this run's own record, and
 * clearing them erased the run's progress: regintel 20260918T132928Z resumed into its core phase
 * with phase-gates.jsonl emptied, the launcher found no GO for scaffold, re-ran the finished
 * phase over committed code, and died in a review deadlock ($2.05, core never reached). The
 * cost ledger went the same way, so the run's spend could not be totalled either.
 *
 * Executes the real pre-run-reset.sh against a temp LOG_DIR, as its sibling tests do.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const RUN = '20260918T132928Z';
const GATE = JSON.stringify({ phase_id: 'scaffold', decision: 'go', timestamp: '2026-09-18T19:43:06-04:00' });
const COST = JSON.stringify({ phase: 'scaffold', story: 'REGI-001-impl', cost: 0.0748 });

function reset(env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'reset-ledgers-')); dirs.push(d);
  const logs = join(d, 'logs'); mkdirSync(logs);
  const prd = join(d, 'x-prd.json'); writeFileSync(prd, JSON.stringify({ stories: [] }));
  const dash = join(d, 'dash'); mkdirSync(dash);
  writeFileSync(join(logs, 'phase-gates.jsonl'), `${GATE}\n`);
  writeFileSync(join(logs, 'phase-cost.jsonl'), `${COST}\n`);
  writeFileSync(join(logs, 'healing-events.jsonl'), '{"story":"REGI-001-tests","retry":1}\n');
  writeFileSync(join(logs, 'run-guidance.jsonl'), '{"storyId":"REGI-004-B","note":"Never import DEFAULT_MODEL from dial","target":"skill"}\n');
  // The writer's rung for a completed story, and the ladder position of an in-progress one — both
  // this run's own record. regintel resume 3 (2026-09-21 12:15): the reset wiped story-rung/, and the
  // reviewer refused REGI-001 six times — "no rung on record" — on work the run itself had completed.
  mkdirSync(join(logs, 'story-rung')); mkdirSync(join(logs, 'story-retry-state'));
  writeFileSync(join(logs, 'story-rung/REGI-001.json'), '{"model":"MiniMax-M3","provider":"minimax","reasoningEffort":"max"}\n');
  writeFileSync(join(logs, 'story-retry-state/REGI-002.json'), '{"rung":1,"attempts":2}\n');
  const r = spawnSync('bash', [RESET, '--prd', prd, '--log-dir', logs], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, COMPOSE_OVERRIDE: join(d, 'override.yml'), DASHBOARD_STATE_DIR: dash, ORCH_RUN_ID: RUN, ...env },
  });
  return { logs, out: `${r.stdout}\n${r.stderr}`, status: r.status };
}

describe('a resume keeps the run\'s own ledgers', () => {
  it('leaves the writer-rung record of a completed story — the reviewer judges it on the rung that produced it', () => {
    const t = reset({ EPAM_RESUME_RUN: RUN });
    expect(existsSync(join(t.logs, 'story-rung/REGI-001.json')),
      `the rung record was cleared — the reviewer will refuse "no rung on record":\n${t.out.slice(-800)}`).toBe(true);
    expect(readFileSync(join(t.logs, 'story-rung/REGI-001.json'), 'utf8')).toContain('MiniMax-M3');
  });

  it('leaves the ladder position of an in-progress story — the resume continues the ladder, not rung 0', () => {
    const t = reset({ EPAM_RESUME_RUN: RUN });
    expect(existsSync(join(t.logs, 'story-retry-state/REGI-002.json'))).toBe(true);
  });

  it('a fresh launch still clears both — no judge inherits a prior run\'s rung', () => {
    const t = reset({});
    expect(existsSync(join(t.logs, 'story-rung/REGI-001.json'))).toBe(false);
    expect(existsSync(join(t.logs, 'story-retry-state/REGI-002.json'))).toBe(false);
  });

  it('leaves phase-gates.jsonl intact, so a finished phase is not run again', () => {
    const t = reset({ EPAM_RESUME_RUN: RUN });
    expect(readFileSync(join(t.logs, 'phase-gates.jsonl'), 'utf8'),
      'the scaffold GO record was cleared — the launcher will re-run the phase').toContain('"scaffold"');
  });

  it('leaves the cost and healing ledgers intact — they are this run\'s record', () => {
    const t = reset({ EPAM_RESUME_RUN: RUN });
    expect(readFileSync(join(t.logs, 'phase-cost.jsonl'), 'utf8')).toContain('0.0748');
    expect(readFileSync(join(t.logs, 'healing-events.jsonl'), 'utf8')).toContain('REGI-001-tests');
  });

  it('leaves the run guidance ledger intact — the analyst\'s notes for this run\'s retries', () => {
    const t = reset({ EPAM_RESUME_RUN: RUN });
    expect(readFileSync(join(t.logs, 'run-guidance.jsonl'), 'utf8')).toContain('REGI-004-B');
  });

  it('says so', () => {
    const t = reset({ EPAM_RESUME_RUN: RUN });
    expect(t.out).toMatch(/resum\w+.*ledger|ledger.*resum\w+/i);
  });
});

describe('a fresh launch still archives and clears them', () => {
  it('archives the previous run\'s ledgers under archive/pre-run-* and empties them', () => {
    const t = reset({ EPAM_RESUME_RUN: '' });
    expect(readFileSync(join(t.logs, 'phase-gates.jsonl'), 'utf8').trim()).toBe('');
    const archives = existsSync(join(t.logs, 'archive')) ? readdirSync(join(t.logs, 'archive')).filter((d) => d.startsWith('pre-run-')) : [];
    expect(archives.length, 'no archive was made').toBeGreaterThan(0);
    expect(readFileSync(join(t.logs, 'archive', archives[0], 'phase-gates.jsonl'), 'utf8')).toContain('"scaffold"');
  });

  it('clears the run guidance ledger — no note from one run reaches another (operator, 2026-08-12)', () => {
    const t = reset({ EPAM_RESUME_RUN: '' });
    expect(readFileSync(join(t.logs, 'run-guidance.jsonl'), 'utf8').trim()).toBe('');
  });
});
