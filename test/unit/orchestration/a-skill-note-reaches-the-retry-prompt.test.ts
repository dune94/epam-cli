/**
 * THE ANALYST'S SKILL NOTE REACHES THE RETRY PROMPT.
 *
 * regintel 20260919T141354Z, REGI-004-B: the writer imported DEFAULT_MODEL from a `dial` package
 * that exports only __version__. The failure analyst diagnosed it exactly and answered
 * target=skill with a note; the log said "Injected skill guidance into retry prompt (244 chars)";
 * the retry prompt carried no such guidance, the same import failed again, and the engine
 * reported "self-healing is NOT working". The same shape on 2026-09-18 (REGI-001-tests,
 * pytest.ini). The `skill)` branch of run_failure_analyst reviews the note and then says
 * "applied to this run only — not persisted across runs" — and stores it nowhere. The retry
 * prompt is built by build_kb_prompt_section, which reads VERIFICATION_FAILURE and the KB file
 * and nothing the analyst produced. `target=skill` was a no-op with a log line claiming otherwise.
 *
 * This executes the two real functions in sequence — the analyst with its model call answered
 * by the recorded diagnosis, then the prompt builder — and asserts on the prompt the writer
 * would receive. Shell functions are testable: the libraries are sourced as claude.sh sources
 * them; only the model, the monitor and the ledger are stubbed.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STORY = 'REGI-004-B';
// The analyst's actual diagnosis from the run; the note in the analyst's own output contract.
const DIAGNOSIS = 'classifier.py imports DEFAULT_MODEL from dial, but dial exports only __version__; get_async_client lives in dial.client and DEFAULT_MODEL exists nowhere.';
const NOTE = 'Never import DEFAULT_MODEL from dial: dial exports only __version__; import get_async_client from dial.client and read the model name from regintel.config.';

function harness(opts: { target: 'skill' | 'kb' | 'none'; note?: string; retry?: number }) {
  const d = mkdtempSync(join(tmpdir(), 'skill-note-')); dirs.push(d);
  // The shadow SCRIPT_DIR is the real scripts directory, entry by entry, with two stand-ins.
  const shadow = join(d, 'scripts'); mkdirSync(shadow, { recursive: true });
  for (const entry of readdirSync(SCRIPTS)) {
    if (entry === 'ai-run.sh' || entry === 'update-monitor.sh') continue;
    symlinkSync(join(SCRIPTS, entry), join(shadow, entry));
  }
  const logs = join(d, 'logs'); mkdirSync(logs);
  mkdirSync(join(d, 'codeline'));
  // $(dirname SCRIPT_DIR)/agents is where the analyst reads the engine profiles and where the
  // kb target writes KB-<role>.md: the real profiles, read-only, in a writable directory.
  const agents = join(d, 'agents'); mkdirSync(agents);
  symlinkSync(join(ROOT, 'orchestrations/agents/profiles.json'), join(agents, 'profiles.json'));
  symlinkSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), join(agents, 'invocation-profiles.json'));
  // The analyst renders the PROJECT's minted prompt, never the template. mock3's, as minted.
  mkdirSync(join(d, 'prompts'));
  copyFileSync(join(ROOT, 'orchestrations/projects/mock3/prompts/failure-analyst.json'), join(d, 'prompts/failure-analyst.json'));
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: STORY, title: 'Classifier tests', agentRole: 'regintel-pipeline-engineer', codeline: 'regintel-build', acceptanceCriteria: ['tests cover the classifier'], testCriteria: { facts: ['test_classifier.py imports only from dial.client'] } }] }));

  // The model: the analyst's reply, recorded. Everything else on ai-run's path is not exercised.
  const reply = JSON.stringify({ diagnosis: DIAGNOSIS, target: opts.target, skill_note: opts.note ?? NOTE, reason: 'deterministic missing-export fact the retry cannot guess' });
  writeFileSync(join(shadow, 'ai-run.sh'), `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' ${JSON.stringify(reply)}\n`);
  chmodSync(join(shadow, 'ai-run.sh'), 0o755);
  writeFileSync(join(shadow, 'update-monitor.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(shadow, 'update-monitor.sh'), 0o755);

  const retry = opts.retry ?? 0;
  const r = spawnSync('bash', ['-c', [
    'set -u',
    'BLUE=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; NC=""',
    `export PROGRESS_LOG=${JSON.stringify(join(d, 'logs/progress.log'))}`,
    'log(){ echo "$*"; }; info(){ echo "$*"; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*" >&2; }; success(){ echo "$*"; }',
    // SCRIPT_DIR is the shadow (its ai-run.sh answers); AUTOMATION_DIR stays the real engine
    // root, as claude.sh sets it, so config and templates resolve exactly as in a run.
    `SCRIPT_DIR=${JSON.stringify(shadow)}; AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}`,
    `export PRD_FILE=${JSON.stringify(prd)} MAIN_PRD_FILE=${JSON.stringify(prd)} LOG_DIR=${JSON.stringify(logs)}`,
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(d)} EPAM_AGENTS_DIR=${JSON.stringify(agents)}`,
    'export ORCH_GATE_PROVIDER=openrouter ESCALATION_MODEL=z-ai/glm-5.3 EPAM_CLI=true ORCH_GATE_ALLOWED_TOOLS=read_file',
    `export VERIFICATION_FAILURE=$'\\n## Verification Failure\\n\\npytest: ImportError: cannot import name DEFAULT_MODEL from dial'`,
    `export PROJECT_ROOT=${JSON.stringify(join(d, 'codeline'))}`,
    // claude.sh's globals and sourcing order, for the libraries this path reaches.
    'SKILL_NOTE_IMPERATIVE_OPENERS="do not|never|always|avoid|use|prefer"; SKILL_NOTE_NORMALIZATION_OPENER="Always"',
    ...['evidence-windows', 'story-acs-block', 'render-engine-prompt', 'story-guards', 'flags', 'common', 'knowledge-base',
        'external-verification', 'failure-healing', 'prd-change-review']
      .map((l) => `. ${JSON.stringify(join(SCRIPTS, `lib/${l}.sh`))}`),
    // helpers the analyst calls that live in the orchestrator body
    'seam_model_or_fail(){ echo "z-ai/glm-5.3"; }',
    'run_healing_recorder(){ :; }',
    `run_failure_analyst ${JSON.stringify(STORY)} ${JSON.stringify(join(d, 'analyst.out'))} ${retry}`,
    'echo "===PROMPT==="',
    `build_kb_prompt_section ${JSON.stringify(STORY)} ${retry + 1} KB-001`,
  ].join('\n')], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, TMPDIR: d } });
  const out = `${r.stdout}\n${r.stderr}`;
  if (process.env.SKILL_NOTE_DEBUG) console.log(out.slice(-1500));
  const prompt = out.includes('===PROMPT===') ? out.split('===PROMPT===')[1] : '';
  return { out, prompt, status: r.status, dir: d };
}

describe('the harness reaches the real analyst', () => {
  it('the analyst ran, parsed the reply and named the target', () => {
    const h = harness({ target: 'skill' });
    expect(h.out, h.out).toContain('[FailureAnalyst] Diagnosis:');
    expect(h.out).toMatch(/Target=skill/);
    expect(h.prompt.length, 'no prompt section was rendered').toBeGreaterThan(0);
  });
});

describe('THE DEFECT: target=skill produced nothing the retry could read', () => {
  it('the retry prompt carries the skill note', () => {
    const h = harness({ target: 'skill' });
    expect(h.prompt, 'the note the analyst wrote is absent from the prompt the writer will get').toContain(NOTE);
  });

  it('the prompt tells the writer the note comes from its own previous failure', () => {
    const h = harness({ target: 'skill' });
    expect(h.prompt).toMatch(/previous attempt|prior attempt|last attempt/i);
  });

  it('the note is not claimed injected when it was not', () => {
    const h = harness({ target: 'skill', note: '' });
    expect(h.out).not.toMatch(/Injected skill guidance/);
  });

  it('a note is not carried to a different story\'s prompt', () => {
    const h = harness({ target: 'skill' });
    const r = spawnSync('bash', ['-c', [
      'log(){ :; }',
      `export PRD_FILE=${JSON.stringify(join(h.dir, 'prd.json'))} LOG_DIR=${JSON.stringify(join(h.dir, 'logs'))} EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(h.dir)}`,
      `. ${JSON.stringify(join(SCRIPTS, 'lib/knowledge-base.sh'))}`,
      'build_kb_prompt_section REGI-009 1 KB-001',
    ].join('\n')], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout).not.toContain(NOTE);
  });
});

describe('the kb target still persists to the KB file', () => {
  it('a kb note lands in the role KB and reaches the prompt through it', () => {
    const h = harness({ target: 'kb' });
    expect(h.prompt).toContain(NOTE);
  });
});
