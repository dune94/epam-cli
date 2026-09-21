/**
 * A CHANGED TEMPLATE REBUILDS THE PROJECT'S PROMPTS — THE ROSTER IS KEPT.
 *
 * regintel 20260920T232518Z ($5.73, 2026-09-20): the launch reused prompts built at 18:17 from
 * the previous day's templates. The mint gate (lib/mint-and-spec.sh) and the mint step
 * (mint-agents-step.js) both decide "this codeline is provisioned" on the EXISTENCE of
 * .prompt-cache/.complete-<codeline> — an empty file that records that a build happened, not
 * what it was built from. The prompt builder beneath it fingerprints every template and would
 * have rebuilt exactly the changed ones; it never ran. Four of the day's fixes were inert:
 * "[prompt-library] … given values it does not use: __SHARED_FILE_OWNERSHIP_BLOCK__ … DROPPED".
 *
 * The marker now carries a digest of the prompt inputs (the template layer, the seam registry,
 * the generator body). Every reader compares it: same → kept, as before; different → the roster
 * is kept and the prompt builder runs, regenerating only what changed. Executed: the marker
 * writer, the digest, and each reader's decision.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const BUILDER = join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const b = require(BUILDER);

/** A private copy of the template layer + registry, so a change here changes nothing real. */
function inputs() {
  const d = mkdtempSync(join(tmpdir(), 'tpl-digest-')); dirs.push(d);
  cpSync(join(ROOT, 'orchestrations/prompts/templates'), join(d, 'templates'), { recursive: true });
  cpSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), join(d, 'invocation-profiles.json'));
  return { templatesDir: join(d, 'templates'), registryFile: join(d, 'invocation-profiles.json'), d };
}

describe('the digest of the prompt inputs', () => {
  it('is stable for the same inputs and changes when a template changes', () => {
    const i = inputs();
    const a = b.promptInputsDigest({ templatesDir: i.templatesDir, registryFile: i.registryFile });
    const a2 = b.promptInputsDigest({ templatesDir: i.templatesDir, registryFile: i.registryFile });
    expect(a).toMatch(/^[0-9a-f]{16,}$/); expect(a2).toBe(a);
    const tpl = join(i.templatesDir, 'spec-agent-openspec.json');
    const doc = JSON.parse(readFileSync(tpl, 'utf8')); doc.body += '\nA NEW RULE'; writeFileSync(tpl, JSON.stringify(doc));
    expect(b.promptInputsDigest({ templatesDir: i.templatesDir, registryFile: i.registryFile })).not.toBe(a);
  });
  it('changes when the registry changes', () => {
    const i = inputs();
    const a = b.promptInputsDigest({ templatesDir: i.templatesDir, registryFile: i.registryFile });
    writeFileSync(i.registryFile, readFileSync(i.registryFile, 'utf8').replace('"profiles"', '"profiles"') + '\n');
    expect(b.promptInputsDigest({ templatesDir: i.templatesDir, registryFile: i.registryFile })).not.toBe(a);
  });
});

describe('the marker records what it was built from, and the readers compare', () => {
  function marked(i: ReturnType<typeof inputs>) {
    const proj = join(i.d, 'project'); mkdirSync(join(proj, 'prompts'), { recursive: true });
    writeFileSync(join(proj, 'prompts', 'x.json'), '{}');
    b.writeCompletionMarker({ outDir: join(proj, 'prompts'), codeline: 'regintel-build', provisioned: 3, templatesDir: i.templatesDir, registryFile: i.registryFile });
    return proj;
  }
  it('the marker file carries the digest', () => {
    const i = inputs(); const proj = marked(i);
    const m = readFileSync(join(proj, '.prompt-cache', '.complete-regintel-build'), 'utf8');
    expect(m.trim()).toBe(b.promptInputsDigest({ templatesDir: i.templatesDir, registryFile: i.registryFile }));
  });
  it('codelinePromptsComplete: same inputs → complete; a changed template → not complete, with the reason', () => {
    const i = inputs(); const proj = marked(i);
    expect(b.codelinePromptsComplete({ projectConfigDir: proj, codeline: 'regintel-build', templatesDir: i.templatesDir, registryFile: i.registryFile }).complete).toBe(true);
    const tpl = join(i.templatesDir, 'tc-writer.json');
    const doc = JSON.parse(readFileSync(tpl, 'utf8')); doc.body += '\nrule 4a'; writeFileSync(tpl, JSON.stringify(doc));
    const r = b.codelinePromptsComplete({ projectConfigDir: proj, codeline: 'regintel-build', templatesDir: i.templatesDir, registryFile: i.registryFile });
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/template|input/i);
  });
  it('an EMPTY marker (the old shape) is not complete — it proves nothing about its inputs', () => {
    const i = inputs(); const proj = join(i.d, 'p2'); mkdirSync(join(proj, '.prompt-cache'), { recursive: true });
    writeFileSync(join(proj, '.prompt-cache', '.complete-regintel-build'), '');
    expect(b.codelinePromptsComplete({ projectConfigDir: proj, codeline: 'regintel-build', templatesDir: i.templatesDir, registryFile: i.registryFile }).complete).toBe(false);
  });
});

describe('the bash mint gate asks the same question', () => {
  it('codeline_prompts_complete (lib/prompt-variant.sh) answers from the marker digest', () => {
    const i = inputs(); const proj = join(i.d, 'p3'); mkdirSync(join(proj, 'prompts'), { recursive: true }); writeFileSync(join(proj, 'prompts', 'x.json'), '{}');
    b.writeCompletionMarker({ outDir: join(proj, 'prompts'), codeline: 'regintel-build', provisioned: 1, templatesDir: i.templatesDir, registryFile: i.registryFile });
    const run = (extra = '') => spawnSync('bash', ['-c', `source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/prompt-variant.sh'))}; export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(proj)} EPAM_PROMPT_TEMPLATES_DIR=${JSON.stringify(i.templatesDir)} EPAM_SEAM_REGISTRY_FILE=${JSON.stringify(i.registryFile)} NODE_BIN=$(command -v node) SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}; ${extra} codeline_prompts_complete regintel-build && echo YES || echo NO`], { encoding: 'utf8' });
    expect(run().stdout + run().stderr).toContain('YES');
    const tpl = join(i.templatesDir, 'failure-analyst.json');
    const doc = JSON.parse(readFileSync(tpl, 'utf8')); doc.body += '\nchanged'; writeFileSync(tpl, JSON.stringify(doc));
    const r = run();
    expect(r.stdout).toContain('NO');
    expect(r.stderr + r.stdout).toMatch(/template|input|rebuil/i);
  });
  it('mint-and-spec.sh and pre-run-reset.sh decide through it, never on the marker\'s existence', () => {
    for (const f of ['orchestrations/scripts/lib/mint-and-spec.sh', 'orchestrations/scripts/pre-run-reset.sh']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      // A marker's existence may still tell "stale" from "never built" (elif) — never decide completeness.
      // Continuation lines are joined so `elif [ … ] \\\n && [ -f marker ]` reads as one condition.
      const joined = src.replace(/\\\n\s*/g, ' ').split('\n');
      const bare = joined.filter((l) => /\[ -f\s+"\$EPAM_PROJECT_CONFIG_DIR\/\.prompt-cache\/\$\(prompt_marker_key/.test(l) && !/^\s*#/.test(l) && !/elif/.test(l));
      expect(bare, `${f} still tests the marker's existence:\n${bare.join('\n')}`).toEqual([]);
      expect(src).toMatch(/codeline_prompts_complete/);
    }
  });
  it('mint-agents-step.js decides through codelinePromptsComplete', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/mint-agents-step.js'), 'utf8');
    expect(src).toMatch(/codelinePromptsComplete\(/);
    expect(src).not.toMatch(/_codelineComplete = fs\.existsSync\(/);
  });
});

describe('stale is not foreign', () => {
  it('the mint gate keeps the roster and clears only the prompts when the codeline\'s marker is stale', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/mint-and-spec.sh'), 'utf8');
    const at = src.indexOf('is this run\'s codeline but its prompt inputs changed');
    expect(at, 'no stale branch').toBeGreaterThan(0);
    const branch = src.slice(at, src.indexOf('\n    else', at));
    expect(branch).toMatch(/rm -rf "\$EPAM_PROJECT_CONFIG_DIR\/prompts"/);
    expect(branch).not.toMatch(/roster\.json/);
    expect(branch).toMatch(/EPAM_SKIP_AGENT_MINT=1/);
  });
});

