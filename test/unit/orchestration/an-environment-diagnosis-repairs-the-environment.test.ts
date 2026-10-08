/**
 * AN ENVIRONMENT DIAGNOSIS REPAIRS THE ENVIRONMENT.
 *
 * Live, 2026-10-08 (test/integration/live/self-heal/run.sh, copilot): a correct change imported a module the repository
 * generates (`npm run generate`, per its README) and the fresh checkout had never generated. The analyst diagnosed it
 * exactly — "hello.ts imports a generated file that `npm test` never generates" — and, because target=environment only
 * said "not the writer's fault" and repaired nothing, answered target=skill: "never import from src/generated/ ...
 * import greetings.json directly". The one capability for this — a reviewed repair script the engine runs before each
 * verification (.epam/dynamic-tools) — was unreachable from an environment diagnosis. In AMSD-2974, 49 of 96 healing
 * events were "environment"; none repaired anything.
 *
 * EXECUTED: run_failure_analyst (lib/failure-healing.sh) with the model's reply recorded, the real change reviewer path
 * (run_change_with_reviewer_retry), then run_dynamic_tools_in_unlocked_window — the function run_external_verification
 * calls before the suite. Asserted on the codeline after the window ran. Only the model is stubbed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// The analyst renders the PROJECT's prompt, never the template: the current template's text, in the project shape the
// builder installs (an unspecialised copy — what this asserts is the engine's handling of the reply, not the wording).
const projectCopy = (id: string) => {
  const t = JSON.parse(readFileSync(join(ROOT, `orchestrations/prompts/templates/${id}.json`), 'utf8'));
  return JSON.stringify({ id, authority: 'project', body: t.body, bodies: t.bodies, placeholders: t.placeholders, mayBeEmpty: t.mayBeEmpty });
};

const STORY = 'S-1';
const REPAIR = { name: 'generate-sources', purpose: 'Generate src/generated/ from greetings.json, as the README requires after cloning', recipe: 'npm run generate' };

function harness(reply: object, reviewerVerdict: 'pass' | 'fail' = 'pass', opts: { reviewerCannotRun?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'env-heal-')); dirs.push(d);
  const shadow = join(d, 'scripts'); mkdirSync(shadow, { recursive: true });
  for (const entry of readdirSync(SCRIPTS)) {
    if (entry === 'ai-run.sh' || entry === 'update-monitor.sh') continue;
    symlinkSync(join(SCRIPTS, entry), join(shadow, entry));
  }
  mkdirSync(join(d, 'logs'));
  // The codeline: a repository whose generator writes the module the story's change imports.
  const cl = join(d, 'codeline'); mkdirSync(join(cl, 'scripts'), { recursive: true });
  writeFileSync(join(cl, 'package.json'), JSON.stringify({ name: 'hello', scripts: { generate: 'node scripts/generate.mjs' } }));
  writeFileSync(join(cl, 'scripts/generate.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('src/generated', { recursive: true });\nwriteFileSync('src/generated/greetings.ts', 'export const GREETINGS = { hello: \"hello there\" };\\n');\n");
  const agents = join(d, 'agents'); mkdirSync(agents);
  symlinkSync(join(ROOT, 'orchestrations/agents/profiles.json'), join(agents, 'profiles.json'));
  symlinkSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), join(agents, 'invocation-profiles.json'));
  mkdirSync(join(d, 'prompts'));
  writeFileSync(join(d, 'prompts/failure-analyst.json'), projectCopy('failure-analyst'));
  // The change reviewer judges the repair from its own project prompt; absent, it cannot run.
  if (!opts.reviewerCannotRun) writeFileSync(join(d, 'prompts/prd-change-reviewer.json'), projectCopy('prd-change-reviewer'));
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: STORY, title: 'greeting', agentRole: 'regintel-pipeline-engineer', codeline: 'hello', acceptanceCriteria: ['getGreeting() returns the table entry'], technicalNotes: { files: ['src/hello.ts'] } }] }));

  // The model. The change reviewer is asked about a tool_creation; everything else is the analyst.
  const review = JSON.stringify({ verdict: reviewerVerdict, reason: reviewerVerdict === 'pass' ? 'idempotent mechanical step the repository documents' : 'not a mechanical step' });
  writeFileSync(join(shadow, 'ai-run.sh'), `#!/usr/bin/env bash
p="$(cat; printf '%s' "$*")"
if printf '%s' "$p" | grep -q 'tool_creation'; then printf '%s' ${JSON.stringify(review)}; else printf '%s' ${JSON.stringify(JSON.stringify(reply))}; fi
`);
  chmodSync(join(shadow, 'ai-run.sh'), 0o755);
  writeFileSync(join(shadow, 'update-monitor.sh'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(shadow, 'update-monitor.sh'), 0o755);

  const r = spawnSync('bash', ['-c', [
    'set -u',
    'BLUE=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; NC=""',
    `export PROGRESS_LOG=${JSON.stringify(join(d, 'logs/progress.log'))}`,
    'log(){ echo "$*"; }; info(){ echo "$*"; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*" >&2; }; success(){ echo "$*"; }',
    `SCRIPT_DIR=${JSON.stringify(shadow)}; AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}`,
    `export PRD_FILE=${JSON.stringify(prd)} MAIN_PRD_FILE=${JSON.stringify(prd)} LOG_DIR=${JSON.stringify(join(d, 'logs'))}`,
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(d)} EPAM_AGENTS_DIR=${JSON.stringify(agents)}`,
    'export ORCH_GATE_PROVIDER=openrouter ESCALATION_MODEL=z-ai/glm-5.3 EPAM_CLI=true ORCH_GATE_ALLOWED_TOOLS=read_file',
    `export VERIFICATION_FAILURE=$'\\n## Verification Failure\\n\\nError: Failed to load url ./generated/greetings (resolved id: ./generated/greetings) in src/hello.ts. Does the file exist?'`,
    `export PROJECT_ROOT=${JSON.stringify(cl)}`,
    'SKILL_NOTE_IMPERATIVE_OPENERS="do not|never|always|avoid|use|prefer"; SKILL_NOTE_NORMALIZATION_OPENER="Always"',
    ...['evidence-windows', 'story-acs-block', 'render-engine-prompt', 'story-guards', 'flags', 'jq-vals', 'common', 'knowledge-base',
        'external-verification', 'failure-healing', 'prd-change-review']
      .map((l) => `. ${JSON.stringify(join(SCRIPTS, `lib/${l}.sh`))}`),
    'seam_model_or_fail(){ echo "z-ai/glm-5.3"; }',
    'run_healing_recorder(){ :; }',
    `run_failure_analyst ${STORY} ${JSON.stringify(join(d, 'analyst.out'))} 1`,
    'echo "CLASS=${COORDINATOR_FAILURE_CLASS:-} ESCALATE=${COORDINATOR_ESCALATE:-}"',
    // The next attempt's verification opens the window before the suite runs.
    `run_dynamic_tools_in_unlocked_window ${JSON.stringify(cl)} ${JSON.stringify(join(d, 'verify.out'))}`,
  ].join('\n')], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, TMPDIR: d } });
  const out = `${r.stdout}\n${r.stderr}`;
  if (process.env.ENV_HEAL_DEBUG) console.log(out.slice(-3000));
  return { out, cl, d };
}

const ENV = { diagnosis: 'src/hello.ts imports src/generated/greetings, which npm run generate writes and this checkout never generated', target: 'environment', reason: 'the code is correct; the environment lacks a documented generation step', evidence: 'README: run npm run generate after cloning; src/generated/ is gitignored', expected_outcome: 'the suite resolves ./generated/greetings and the story test passes' };

describe('an environment diagnosis that names the repair', () => {
  it('the analyst ran and named the target (the harness reached the real analyst)', () => {
    const h = harness({ ...ENV, tool_spec: REPAIR });
    expect(h.out, h.out).toContain('[FailureAnalyst] Diagnosis:');
    expect(h.out).toMatch(/Target=environment/);
  });

  it('the repair runs before the next verification: the environment is put right', () => {
    const h = harness({ ...ENV, tool_spec: REPAIR });
    expect(existsSync(join(h.cl, 'src/generated/greetings.ts')), h.out).toBe(true);
    expect(readFileSync(join(h.cl, 'src/generated/greetings.ts'), 'utf8')).toContain('hello there');
  });

  it('it is the reviewed repair, nothing else: one tool, its .reviewed marker, the recipe it was given', () => {
    const h = harness({ ...ENV, tool_spec: REPAIR });
    const tools = join(h.cl, '.epam/dynamic-tools');
    expect(readdirSync(tools).sort()).toEqual(['generate-sources.sh', 'generate-sources.sh.reviewed']);
    expect(readFileSync(join(tools, 'generate-sources.sh'), 'utf8')).toContain('npm run generate');
    expect(h.out, 'written without a review that ran').toMatch(/PRD-Reviewer\] APPROVED tool_creation/);
  });

  it('classed as the coordinator\'s environment class, so no stronger model is spent on it', () => {
    const h = harness({ ...ENV, tool_spec: REPAIR });
    expect(h.out).toMatch(/CLASS=env ESCALATE=no/);
  });
});

describe('what an environment diagnosis must not do', () => {
  it('a repair the reviewer rejects is never written and never runs', () => {
    const h = harness({ ...ENV, tool_spec: REPAIR }, 'fail');
    expect(h.out, h.out).toMatch(/Target=environment/);
    expect(existsSync(join(h.cl, '.epam/dynamic-tools/generate-sources.sh'))).toBe(false);
    expect(existsSync(join(h.cl, 'src/generated/greetings.ts'))).toBe(false);
  });

  // Found writing this test: run_prd_change_reviewer could not render its prompt, said "refusing to review", returned no
  // verdict — and run_change_with_reviewer_retry, which accepted anything but "fail", wrote the tool with a .reviewed
  // marker. Same for "unreviewed" (no gate provider), which its own comment says must revert.
  it('a reviewer that cannot run approves nothing: no tool, no .reviewed marker, nothing runs', () => {
    const h = harness({ ...ENV, tool_spec: REPAIR }, 'pass', { reviewerCannotRun: true });
    expect(h.out, h.out).toMatch(/PRD-Reviewer\] cannot render its prompt/);
    expect(existsSync(join(h.cl, '.epam/dynamic-tools/generate-sources.sh.reviewed'))).toBe(false);
    expect(existsSync(join(h.cl, '.epam/dynamic-tools/generate-sources.sh'))).toBe(false);
    expect(existsSync(join(h.cl, 'src/generated/greetings.ts'))).toBe(false);
  });

  it('no repair named: nothing is written, the class still says environment', () => {
    const h = harness(ENV);
    expect(h.out, h.out).toMatch(/Target=environment/);
    expect(existsSync(join(h.cl, '.epam/dynamic-tools'))).toBe(false);
    expect(h.out).toMatch(/CLASS=env ESCALATE=no/);
  });
});
