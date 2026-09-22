/**
 * A STALE PROJECT PROMPT MUST FORCE REGENERATION, NOT SILENT REUSE.
 *
 * pre-run-reset.sh's cache-reuse decision checks only for the presence of the
 * `.prompt-cache/.complete-<codeline>` marker file. It never validates whether each
 * project prompt's `derivedFromSha256` still matches the current template.
 *
 * On run 20260917T124016Z the runtime-boundary-review project prompt was generated on
 * Sept 6 from a template that carried `__STORY_TITLE__`. The template was updated on
 * Sept 14 (commit 5260e4ad) to use `__GATE_SCOPE__` instead. The marker was present,
 * so the stale prompt was silently reused — the engine tried to render it, passed
 * `__GATE_SCOPE__`, and the prompt-library refused: "cannot render its prompt —
 * refusing to gate with no instructions." 12 of 41 metrolinx project prompts carry
 * this defect.
 *
 * Fix: after the marker is found, validate each project prompt's `derivedFromSha256`
 * against the SHA256 of its template's current `{id, body, placeholders}`. Any mismatch
 * clears the marker and forces regeneration, so the cache only reuses prompts that are
 * current against their template.
 *
 * The SHA256 is computed the same way buildGeneratedDoc() does:
 *   crypto.createHash('sha256')
 *     .update(JSON.stringify({ id, body, placeholders: sorted(placeholders) }))
 *     .digest('hex')
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { engineSource } from '../../lib/engine-source';
import { currentPromptDigest } from '../../helpers/prompt-marker';

const ROOT = join(__dirname, '../../../');
const RESET_SH = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const PROMPT_VARIANT = join(ROOT, 'orchestrations/scripts/lib/prompt-variant.sh');
const NODE_BIN = join(ROOT, '..', '..', '..', '.nvm/versions/node/v20.20.0/bin/node');

const sorted = (a: unknown) => [...(Array.isArray(a) ? a : [])].sort();

function templateHash(tpl: { id: string; body: string; placeholders: string[] }): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: tpl.id, body: tpl.body, placeholders: sorted(tpl.placeholders) }))
    .digest('hex');
}

interface PromptShape {
  id: string;
  body: string;
  placeholders: string[];
  derivedFromSha256: string;
}

/** Build a temp project env with one project prompt and a completion marker. */
function buildEnv(opts: {
  codeline: string;
  prompt: PromptShape;
  templateBody?: string;
  templatePlaceholders?: string[];
}): { projectDir: string; templateDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'stale-prompt-'));
  const projectDir = join(root, 'project');
  const templateDir = join(root, 'templates');
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  mkdirSync(join(projectDir, '.prompt-cache'), { recursive: true });
  mkdirSync(templateDir, { recursive: true });

  // Write the project prompt
  writeFileSync(
    join(projectDir, 'prompts', `${opts.prompt.id}.json`),
    JSON.stringify(opts.prompt),
  );

  // Write the template — by default identical to the prompt (fresh); caller may override
  const tplBody = opts.templateBody ?? opts.prompt.body;
  const tplPh   = opts.templatePlaceholders ?? opts.prompt.placeholders;
  writeFileSync(join(templateDir, `${opts.prompt.id}.json`), JSON.stringify({
    id: opts.prompt.id, body: tplBody, placeholders: tplPh,
  }));

  // Write the completion marker (brownfield = false → plain .complete-<codeline>)
  // The marker carries the digest of the current prompt inputs (2026-09-21); an empty one is
  // now itself the stale signal, so a fixture standing up a COMPLETED codeline writes the digest.
  writeFileSync(join(projectDir, '.prompt-cache', `.complete-${opts.codeline}`), currentPromptDigest());

  return { projectDir, templateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Extract and run the reuse-decision block from pre-run-reset.sh. Returns _CODELINE_ASSETS_REUSED. */
function runReuseBlock(opts: {
  codeline: string;
  projectDir: string;
  templateDir: string;
}): { assetsReused: string; stderr: string } {
  const src = engineSource(RESET_SH);

  // The block we want starts at the 'if [ "${EPAM_REGENERATE_CODELINE_ASSETS:-0}" = "1" ]'
  // guard and ends just before the 'if [ "$_CODELINE_ASSETS_REUSED" = "1" ] && [ -n "$_ROSTER_FILE"'
  // resume-roster block.
  const startMark = '# One test, no parse.';
  const endMark   = '# A RESUME IS NOT THE NEXT RUN';
  const start = src.indexOf(startMark);
  const end   = src.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error('reuse block markers not found in pre-run-reset.sh — harness is stale');

  const block = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'reuse-test-'));
  try {
    const script = join(dir, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
NODE_BIN="${NODE_BIN}"
EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(opts.projectDir)}
EPAM_CODELINE_ID=${JSON.stringify(opts.codeline)}
EPAM_REGENERATE_CODELINE_ASSETS=0
EPAM_TEMPLATES_DIR=${JSON.stringify(opts.templateDir)}
EPAM_BROWNFIELD=0
_CODELINE_ASSETS_REUSED=0
_CODELINE_DECISION_DEFERRED=0
info()    { echo "INFO: $*" >&2; }
warning() { echo "WARN: $*" >&2; }

. ${JSON.stringify(PROMPT_VARIANT)}

${block}

echo "_CODELINE_ASSETS_REUSED=$_CODELINE_ASSETS_REUSED"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30_000 });
    const m = (r.stdout ?? '').match(/_CODELINE_ASSETS_REUSED=([01])/);
    return { assetsReused: m ? m[1] : '(not printed)', stderr: r.stderr ?? '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('a stale project prompt forces regeneration', () => {
  it('when derivedFromSha256 does NOT match the current template, assets are NOT reused', () => {
    // Build a project prompt whose hash does NOT match the template we give it.
    // This simulates the runtime-boundary-review situation: generated from an old template,
    // but the template has since changed.
    const stalePrompt: PromptShape = {
      id: 'test-gate',
      body:         'Review __STORY_TITLE__ in scope __PROJECT_ROOT__.',
      placeholders: ['__STORY_TITLE__', '__PROJECT_ROOT__'],
      // Deliberately wrong hash — simulates a prompt generated from a different template body
      derivedFromSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    // Current template uses __GATE_SCOPE__ instead of __STORY_TITLE__
    const env = buildEnv({
      codeline: 'next.gotransit.com',
      prompt: stalePrompt,
      templateBody: 'Review __GATE_SCOPE__ in scope __PROJECT_ROOT__.',
      templatePlaceholders: ['__GATE_SCOPE__', '__PROJECT_ROOT__'],
    });
    try {
      const { assetsReused, stderr } = runReuseBlock({
        codeline: 'next.gotransit.com',
        projectDir: env.projectDir,
        templateDir: env.templateDir,
      });
      expect(assetsReused, [
        `Expected _CODELINE_ASSETS_REUSED=0 because the project prompt's derivedFromSha256`,
        `does not match the current template hash.`,
        `The stale prompt would fail at render time; the gate would abort.`,
        `stderr: ${stderr.slice(0, 400)}`,
      ].join('\n')).toBe('0');
    } finally { env.cleanup(); }
  });

  it('when derivedFromSha256 matches the current template, assets ARE reused', () => {
    // Build a project prompt whose hash matches the template exactly — fresh, valid reuse.
    const tpl = { id: 'test-gate', body: 'Review __GATE_SCOPE__ in scope __PROJECT_ROOT__.', placeholders: ['__GATE_SCOPE__', '__PROJECT_ROOT__'] };
    const freshPrompt: PromptShape = {
      id: tpl.id,
      body: tpl.body,
      placeholders: tpl.placeholders,
      derivedFromSha256: templateHash(tpl),
    };
    const env = buildEnv({ codeline: 'next.gotransit.com', prompt: freshPrompt });
    try {
      const { assetsReused, stderr } = runReuseBlock({
        codeline: 'next.gotransit.com',
        projectDir: env.projectDir,
        templateDir: env.templateDir,
      });
      expect(assetsReused, [
        `Expected _CODELINE_ASSETS_REUSED=1 for a fresh prompt but got 0.`,
        `stderr: ${stderr.slice(0, 400)}`,
      ].join('\n')).toBe('1');
    } finally { env.cleanup(); }
  });
});
