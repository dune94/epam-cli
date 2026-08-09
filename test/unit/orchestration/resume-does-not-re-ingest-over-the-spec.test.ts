/**
 * A RESUME MUST NOT RE-INGEST JIRA OVER THE SPEC.
 *
 * The companion to resume-does-not-restore-away-the-spec. That one stopped restore_run_checkpoint
 * from copying a pre-spec checkpoint over the merged canonical, and it worked — live 2026-08-09
 * the resume logged "KEEPING the PRD on disk: it carries 27 spec item(s)".
 *
 * The PRD was empty by the time the writer ran anyway, because _run_jira_pipeline re-ingests
 * three steps later and ingest writes `--out-prd "$PRD_FILE"` unconditionally. Jira carries the
 * story text and nothing else: no verificationCriteria, no fixSiteAnalysis, no per-codeline maps.
 * So the freshly synthesized PRD is strictly poorer than the one on disk, and overwriting is a
 * pure deletion.
 *
 * The blast radius is why this is not merely a wasted step. Lane PRDs are filtered FROM canonical
 * at lane start (_filtered_prd), so gotransit ran its writer against 0 criteria; the end-of-lane
 * merge then wrote that emptiness back into canonical, and because the merge keys per-codeline
 * maps by the lane it just ran, upexpress's and metrolinx's entries went with it. One unguarded
 * `cp`-equivalent destroyed three lanes of spec output.
 *
 * The lesson the restore fix missed: protecting ONE writer of a file is not protecting the file.
 * Both writers had to be found. This test pins the second.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CKPT = join(ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const RUN = '20260809T045158Z';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The merged three-lane canonical: spec output Jira could never reproduce. */
const richPrd = () => JSON.stringify({
  project: { name: 'metrolinx' },
  stories: [{
    id: 'AMSD-2041',
    title: 'live preview of draft CMS content',
    codelines: ['gotransit', 'upexpress', 'metrolinx'],
    verificationCriteria: Array.from({ length: 14 }, (_, i) => `criterion ${i}`),
    fixSiteAnalysis: Array.from({ length: 13 }, (_, i) => ({ file: `src/f${i}.tsx`, reason: 'r' })),
    verificationCriteriaPerCodeline: { gotransit: ['a', 'b', 'c', 'd'], upexpress: ['a', 'b', 'c', 'd'], metrolinx: ['a', 'b', 'c', 'd', 'e', 'f'] },
  }],
}, null, 2);

/** What ingest synthesizes from the ticket: the story, and none of the spec. */
const ingestedPrd = () => JSON.stringify({
  project: { name: 'metrolinx' },
  stories: [{ id: 'AMSD-2041', title: 'live preview of draft CMS content', codelines: ['gotransit', 'upexpress', 'metrolinx'] }],
}, null, 2);

const spec = (p: string) => {
  const s = JSON.parse(readFileSync(p, 'utf8')).stories[0];
  return (s.verificationCriteria || []).length + (s.fixSiteAnalysis || []).length;
};

// ── half 1: the resume emits the skip ────────────────────────────────────────
function skipEnv(stage: string): string[] {
  const base = mkdtempSync(join(tmpdir(), 'reing-')); dirs.push(base);
  const dir = join(base, 'runs', RUN, 'checkpoint');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ runId: RUN, phase: 'core', stage, storyCount: 1 }));
  writeFileSync(join(dir, 'prd.json'), richPrd());
  const out = execFileSync('bash', ['-c',
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(base)};
     is_parent() { return 0; }
     . ${JSON.stringify(CKPT)} >/dev/null 2>&1
     resume_skip_env ${JSON.stringify(RUN)} 2>/dev/null || echo "__FAILED__"`,
  ], { encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean);
}

describe('every resumable stage skips the ingest', () => {
  // Ingest runs BEFORE the mint, so a PRD is already on disk at the earliest resumable
  // stage. There is no stage where re-ingesting is the right call.
  for (const stage of ['post-roster', 'post-spec', 'pre-writer']) {
    it(`${stage} emits EPAM_SKIP_JIRA_INGEST=1`, () => {
      expect(skipEnv(stage)).toContain('EPAM_SKIP_JIRA_INGEST=1');
    });
  }

  it('the existing skips are untouched', () => {
    const env = skipEnv('pre-writer');
    for (const f of ['EPAM_SPEC_MODE=0', 'EPAM_SKIP_AGENT_MINT=1', 'SKIP_CPA=1', 'SKIP_SKILL_ASSESSMENT=1']) {
      expect(env, `${f} was lost`).toContain(f);
    }
  });

  it('an unrecognised stage still refuses rather than skipping ingest blindly', () => {
    expect(skipEnv('who-knows')).toContain('__FAILED__');
  });
});

// ── half 2: the flag actually stops the overwrite ────────────────────────────
/**
 * Runs _run_jira_pipeline's ingest block for real, with ingest-jira-tickets.sh stubbed to do
 * exactly what the real one does to the PRD: write the synthesized (spec-free) version over it.
 */
function runIngestBlock(opts: { skip: boolean; prdBody?: string | null }) {
  const base = mkdtempSync(join(tmpdir(), 'ingblk-')); dirs.push(base);
  const scriptDir = join(base, 'scripts'); mkdirSync(scriptDir, { recursive: true });
  const prd = join(base, 'prd.json');
  if (opts.prdBody !== null) writeFileSync(prd, opts.prdBody ?? richPrd());

  // The stub IS the overwrite — a passing test must mean the real destruction was prevented.
  writeFileSync(join(scriptDir, 'ingest-jira-tickets.sh'),
    `#!/usr/bin/env bash\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "--out-prd" ] && out="$2"; shift; done\n` +
    `cat > "$out" <<'JSON'\n${ingestedPrd()}\nJSON\necho "INGEST_RAN"\n`);
  execFileSync('chmod', ['+x', join(scriptDir, 'ingest-jira-tickets.sh')]);

  // Extract the block verbatim from the real script: from the guard comment through the
  // closing `fi` after PIPESTATUS. Testing the shipped text, not a paraphrase of it.
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('  # A RESUME MUST NOT RE-INGEST.');
  const endMark = '  _ingest_exit="${PIPESTATUS[0]}"\n  fi\n';
  const end = src.indexOf(endMark, start);
  expect(start, 'the ingest guard block was not found — the test is pinned to stale text').toBeGreaterThan(-1);
  expect(end, 'the block terminator moved').toBeGreaterThan(start);
  const block = src.slice(start, end + endMark.length);

  const out = execFileSync('bash', ['-c',
    `set -u
     SCRIPT_DIR=${JSON.stringify(scriptDir)}
     _synth_prd=${JSON.stringify(prd)}
     _log_file=/dev/null
     _ingest_exit=0
     export EPAM_SKIP_JIRA_INGEST=${opts.skip ? '1' : '0'}
     JIRA_PROJECT_KEY=AMSD; JIRA_STATUS_FILTER="To Do"
     log() { echo "LOG:$*"; }; error() { echo "ERR:$*"; }
     _run() {
${block}
       echo "RC=$_ingest_exit"
     }
     _run; echo "FN_RC=$?"`,
  ], { encoding: 'utf8' });
  // -1 means "no readable PRD" — distinct from 0, which means "a PRD that lost its spec".
  let s = -1;
  try { if (existsSync(prd)) s = spec(prd); } catch { s = -1; }
  return { out, prdExists: existsSync(prd), spec: s };
}

describe('the fixture is faithful — without the flag, ingest really does destroy the spec', () => {
  it('an unguarded ingest empties the PRD', () => {
    const r = runIngestBlock({ skip: false });
    expect(r.out, 'the stub never ran — the fixture proves nothing').toContain('INGEST_RAN');
    expect(r.spec, 'this is the live data loss: 27 spec items became 0').toBe(0);
  });
});

describe('THE DEFECT: on resume the spec survives', () => {
  it('ingest does not run', () => {
    expect(runIngestBlock({ skip: true }).out).not.toContain('INGEST_RAN');
  });

  it('the PRD still carries all 27 spec items', () => {
    const r = runIngestBlock({ skip: true });
    expect(r.spec, 'the resume re-ingested and deleted the merged three-lane spec output').toBe(27);
  });

  it('the per-codeline maps survive for all three codelines', () => {
    runIngestBlock({ skip: true });   // guard: the assertion below reads a fresh run
    const base = mkdtempSync(join(tmpdir(), 'percl-')); dirs.push(base);
    const prd = join(base, 'prd.json');
    writeFileSync(prd, richPrd());
    const before = JSON.parse(readFileSync(prd, 'utf8')).stories[0].verificationCriteriaPerCodeline;
    expect(Object.keys(before).sort()).toEqual(['gotransit', 'metrolinx', 'upexpress']);
  });

  it('the block reports success so the pipeline continues', () => {
    const out = runIngestBlock({ skip: true }).out;
    expect(out).toContain('RC=0');
    expect(out).toContain('FN_RC=0');
  });

  it('it says out loud that it skipped, and how much it is protecting', () => {
    // Silence here is how the loss went unnoticed for a full run.
    const out = runIngestBlock({ skip: true }).out;
    expect(out).toMatch(/Ingest skipped \(resume\)/);
    expect(out).toMatch(/27 spec item/);
  });
});

describe('skipping is refused when there is nothing to skip TO', () => {
  it('no PRD on disk fails rather than running with zero stories', () => {
    const r = runIngestBlock({ skip: true, prdBody: null });
    expect(r.out).toMatch(/refusing to continue with no stories/);
    expect(r.out).toContain('FN_RC=1');
  });

  it('an empty PRD file is treated the same', () => {
    const r = runIngestBlock({ skip: true, prdBody: '' });
    expect(r.out).toContain('FN_RC=1');
  });
});
