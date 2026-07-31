/**
 * The agent needs to be TOLD adding a dependency is safe, not left to guess.
 *
 * Live metrolinx 2026-07-30/31, upexpress lane. The model's own output, across
 * at least 3 of ~7 attempts spanning the ENTIRE model ladder (starting at
 * MiniMax-M3, escalating through z-ai/glm-5.1/5.2, up to the top rung
 * moonshotai/kimi-k3), was the identical stall:
 *
 *   "The installed `contentstack` SDK has no `livePreview.onContentUpdate`.
 *    Let me check if `@contentstack/live-preview-utils` can be installed:"
 *
 * — then nothing. No tool call. The sentence repeated verbatim and the turn
 * ended, burning the full watchdog timeout (600s, then 900s) each time. That
 * every model tier hit the SAME wall, including the strongest configured
 * model, rules out "not smart enough" — the model correctly diagnosed the
 * missing dependency and then had no instruction telling it this was a
 * normal, already-solved situation, so it hedged instead of acting.
 *
 * dependency-check ALREADY auto-installs whatever a story imports (that's
 * the entire mechanism the "11:30" phantom-import fix, earlier the same
 * night, was protecting). Nothing in the implementation prompt ever told the
 * agent that fact. It stalled asking permission for something the pipeline
 * had already automated.
 *
 * THE CONSTRAINT THAT MATTERS: this directive must not claim a capability
 * that isn't actually configured. It fires ONLY when
 * PROJECT_ROOT/.epam/dependency-check.json exists — the same manifest whose
 * presence is what makes the claim true. No package name, no language, no
 * install command appears in the directive text; it describes the mechanism
 * generically (the same way dependency-check.json's own installCommand is
 * config-supplied, not hardcoded to npm).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(withManifest: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'new-dep-directive-'));
  cleanupDirs.push(d);
  if (withManifest) {
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam', 'dependency-check.json'), JSON.stringify({
      manifestFile: 'package.json', manifestKeys: ['dependencies'],
      scanFileExtensions: ['.ts'], importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
      installCommand: 'echo {package}', vendorDirs: ['node_modules'],
    }));
  }
  return d;
}

function run(block: string, env: NodeJS.ProcessEnv, projectRoot: string): string {
  const script = `
run_extracted() {
  local PROJECT_ROOT='${projectRoot}'
${block}
  echo "$new_dependency_directive"
}
run_extracted
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('the new-dependency directive exists and is wired into the prompt', () => {
  const block = extractBlock(
    '    local new_dependency_directive=""',
    '\n\n    # Deterministic contract injection',
  );

  it('fires when the project has a dependency-check manifest', () => {
    const repo = makeRepo(true);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    expect(out.trim(), 'no directive was emitted even though the manifest exists — the ' +
      'model is left to guess again, exactly as it did live').not.toBe('');
  });

  it('names no specific package, language, or install command — stays generic', () => {
    const repo = makeRepo(true);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    expect(out).not.toMatch(/contentstack/i);
    expect(out).not.toMatch(/npm install|pip install|cargo add/i);
  });

  it('tells the agent to act, not to ask', () => {
    const repo = makeRepo(true);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    // The live failure was literally the model asking "can be installed" and
    // stopping. The directive must make clear no permission step is needed.
    expect(out.toLowerCase()).toMatch(/automatic|does not need|no need to ask|proceed/);
  });

  it('does not fire when no dependency-check manifest exists — the claim would be false', () => {
    const repo = makeRepo(false);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    expect(out.trim(), 'the directive claimed auto-install is available when nothing ' +
      'configures it — the agent would be told something untrue').toBe('');
  });

  it('does not fire outside brownfield', () => {
    // Greenfield has no existing manifest reality to reference in the same
    // way — scope this to the mode it was diagnosed in, not force it everywhere.
    const repo = makeRepo(true);
    const env = { ...process.env };
    delete env.EPAM_BROWNFIELD;
    const out = run(block, env, repo);
    expect(out.trim()).toBe('');
  });
});

describe('the directive is actually injected into the final prompt text', () => {
  it('is referenced in the prompt assembly, not just computed and discarded', () => {
    const i = src.indexOf('local new_dependency_directive=""');
    expect(i).toBeGreaterThan(-1);
    const after = src.slice(i, i + 12000);
    expect(after, 'new_dependency_directive is computed but never interpolated into ' +
      'the prompt — the agent never sees it')
      .toMatch(/\$new_dependency_directive/);
  });
});
