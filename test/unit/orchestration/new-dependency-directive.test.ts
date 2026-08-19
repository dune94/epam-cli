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
  // A real ecosystem manifest + lockfile. Since 2026-08-19 the directive is gated on a KNOWN
  // ECOSYSTEM (what it needs to name an add-command) rather than on .epam/dependency-check.json
  // (what the OLD auto-install promise needed). `withManifest` still controls the .epam/ config,
  // which now only decides WHICH command is named, not whether the directive fires.
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {} }));
  writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 2, packages: {} }));
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

const ROOT = join(__dirname, '../../..');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

function run(block: string, env: NodeJS.ProcessEnv, projectRoot: string): string {
  // THE BLOCK NO LONGER STANDS ALONE. Since 2026-08-19 it renders a template rather than carrying
  // its own prose, so it calls render_engine_prompt, _project_install_command and the ecosystem
  // handler. Stubbing those would test a stub; the REAL ones are sourced and lifted here, and the
  // caller below asserts the render is non-empty so a harness that silently produces nothing
  // cannot pass as "the directive correctly stayed silent".
  const script = `
SCRIPT_DIR='${join(ROOT, 'orchestrations/scripts')}'
AUTOMATION_DIR='${join(ROOT, 'orchestrations')}'
NODE_CMD='${NODE}'
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# The block builds its values file with jq_vals (values reach jq through files, never
# argv). Unsourced it is command-not-found, the values file is EMPTY, and the render fails
# — which reads here as "the directive did not fire".
source "$SCRIPT_DIR/lib/jq-vals.sh"
eval "$(awk '/^_project_dep_config_value\\(\\) \\{/,/^\\}/' "$SCRIPT_DIR/claude.sh")"
eval "$(awk '/^_project_install_command\\(\\) \\{/,/^\\}/' "$SCRIPT_DIR/claude.sh")"
# A HARNESS THAT LIFTED NOTHING MUST NOT LOOK LIKE A DIRECTIVE THAT CORRECTLY STAYED SILENT.
# The awk patterns above lost their backslashes through the template literal once already, which
# defined no functions, emitted no directive, and made every empty-string expectation below pass.
command -v _project_install_command >/dev/null || { echo "HARNESS DID NOT LIFT claude.sh" >&2; exit 3; }
run_extracted() {
  local PROJECT_ROOT='${projectRoot}'
${block}
  echo "$new_dependency_directive"
}
run_extracted
`;
  try {
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  } catch (e) {
    throw new Error(`harness failed: ${(e as { stderr?: Buffer }).stderr ?? e}`);
  }
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

  it('names no specific package, and no install command of the ENGINE\'s choosing', () => {
    const repo = makeRepo(true);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    expect(out).not.toMatch(/contentstack/i);
    // The rendered directive DOES name an install command from 2026-08-19 -- it has to, or the
    // writer cannot act on it -- but only the one this project declares. The fixture declares
    // `echo {package}`, so any ecosystem default appearing here means the engine guessed.
    expect(out).toContain('echo <package>');
    expect(out).not.toMatch(/npm install|pip install|cargo add/i);
  });

  it('carries no ecosystem in the template itself — that is where hardcoding would live', () => {
    const body = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/prompts/templates/new-dependency-directive.json'), 'utf8')).body as string;
    expect(body).not.toMatch(/npm|pip|cargo|yarn|pnpm|bundle|package\.json/i);
  });

  it('tells the agent to act, not to ask', () => {
    const repo = makeRepo(true);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    // The live failure was literally the model asking "can be installed" and stopping, so the
    // requirement is that the agent is told not to stall. The old assertion matched the old
    // WORDING -- including "automatic" and "does not need your permission", which were the false
    // half of that prose: nothing installs on its own unless the project declares autoInstall,
    // and AMSD-2041 believed it and shipped a manifest no lockfile resolved. The requirement
    // survives the rewording; the wording does not.
    expect(out.toLowerCase()).toMatch(/do not stop|without asking|no need to ask|continue|proceed/);
    expect(out.toLowerCase(), 'the false promise came back').not.toContain('automatically');
  });

  it('never claims a capability nothing configures', () => {
    // RE-EXPRESSED 2026-08-19, and the change is deliberate.
    //
    // This asserted the directive stays SILENT without .epam/dependency-check.json, because the
    // original text promised "missing imports are detected and installed automatically" — true
    // only where the project declares autoInstall. The requirement was: do not tell the agent
    // something untrue.
    //
    // The text no longer makes that promise; it tells the writer to run the add-command itself.
    // So silence is no longer what protects the agent from a false claim — and enforcing it did
    // real harm: live AMSD-2041 on 2026-08-19, that file was absent, lockfile-sync blocked four
    // times, and the writer was never told how to comply.
    //
    // The REQUIREMENT survives; only what satisfies it changed. The directive must promise no
    // automation, and must name a command that actually exists.
    const repo = makeRepo(false);
    const out = run(block, { EPAM_BROWNFIELD: '1' }, repo);
    expect(out.toLowerCase(), 'the false auto-install promise came back').not.toContain('automatic');
    expect(out.toLowerCase()).not.toContain('does not need your permission');
    expect(out, 'named no command at all, so the writer cannot act on it').toMatch(/install|add/);
  });

  it('stays silent when it cannot name a real command', () => {
    // The genuine "say nothing" case: no manifest of any known ecosystem, so there is no
    // add-command to name and nothing truthful to say.
    const d = mkdtempSync(join(tmpdir(), 'new-dep-noeco-'));
    cleanupDirs.push(d);
    expect(run(block, { EPAM_BROWNFIELD: '1' }, d).trim()).toBe('');
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
