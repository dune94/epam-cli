/**
 * A MOCK MUST NAME A MODULE THE CODE ACTUALLY USES.
 *
 * Live failure, run 20260815T142007Z (metrolinx, AMSD-2041). The repro-test-writer produced
 * a spec that mocked a transport module the SDK under test never calls. The mock therefore
 * intercepted nothing, the real code path ran, and three assertions failed:
 *
 *     suiteState: "red"  ->  Step 3.55  ->  "Blocking before review."  ->  run failed
 *
 * The implementation was sound. tsc passed. 1200 of 1203 tests passed, and all three
 * failures were inside the spec this agent had just written. The run was failed by a
 * fabricated mock target.
 *
 * THE ASYMMETRY THAT ALLOWED IT. The code-graph-detective is already forbidden to name a
 * third-party symbol it has not proven, and is given resolve-package-symbol.sh to prove it
 * with. The repro-test-writer — which names third-party modules constantly, because that is
 * what mocking IS — had no such instruction and no such tool. One agent was held to
 * evidence and the other was trusted to remember, so the one trusted to remember
 * hallucinated a dependency that was plausible for the ecosystem and absent from the code.
 *
 * THE REQUIREMENT: before mocking a module, prove the code under test actually reaches it.
 * A package being installed, or present in package.json, is not proof that the file being
 * tested imports it.
 *
 * THESE TESTS RENDER THE PROJECT PROMPT, not the template. prompt-library.js executes the
 * project-authority copy and NEVER the template, so a template-only edit is inert. The
 * parity test at the bottom exists because that exact mistake was made once already while
 * fixing blocker-discipline.
 *
 * NOTHING PROJECT-SPECIFIC. The instruction names no package, no framework and no ticket;
 * the negative test below asserts that directly.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/prompt-library.js');
const PROJECT_DIR = join(ROOT, 'orchestrations/projects/metrolinx');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/repro-test-writer.json');
const PROJECT_PROMPT = join(PROJECT_DIR, 'prompts/repro-test-writer.json');

/**
 * Render exactly as brownfield-repro-test-writer.sh:321 does. Rendering is strict in both
 * directions, so every declared placeholder is supplied from the prompt's own declaration —
 * hardcoding the list here would rot the moment the prompt gained a placeholder.
 */
function renderPrompt(): string {
  const declared: string[] = JSON.parse(readFileSync(PROJECT_PROMPT, 'utf8')).placeholders;
  const values: Record<string, string> = {};
  // Stubs must not themselves look like placeholders — rendering rejects any __UPPER__
  // pattern surviving in the output, and a stub of `<__FIX_DIFF__>` is exactly that.
  for (const p of declared) values[p] = `[stub:${p.replace(/_/g, '').toLowerCase()}]`;

  const dir = mkdtempSync(join(tmpdir(), 'repro-prompt-'));
  try {
    const valuesFile = join(dir, 'values.json');
    writeFileSync(valuesFile, JSON.stringify(values));
    const res = spawnSync(
      process.execPath,
      [LIB, 'render', 'repro-test-writer', PROJECT_DIR, valuesFile],
      { encoding: 'utf8' },
    );
    // stderr carries prompt-library's own failure text; surfacing it turns a silent
    // empty render into a legible failure instead of a wall of vacuous passes.
    if (res.status !== 0) throw new Error(`render failed: ${res.stderr}`);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the repro-test-writer is told to prove a mock target exists', () => {
  it('renders a non-empty prompt — otherwise every assertion here is vacuous', () => {
    const out = renderPrompt();
    expect(out.length).toBeGreaterThan(500);
    expect(out, 'did not render the real prompt').toMatch(/You are a TEST ENGINEER/);
  });

  it('gives it the same proving tool the detective already has', () => {
    const out = renderPrompt();
    expect(out, 'the agent is asked to verify with no tool to verify with')
      .toMatch(/resolve-package-symbol\.sh/);
  });

  it('states that a mocked module must be one the code under test actually reaches', () => {
    const out = renderPrompt();
    expect(out).toMatch(/mock/i);
    // The instruction must bind mocking to the imports of the file under test, not to the
    // agent's belief about the ecosystem.
    expect(out).toMatch(/import/i);
    expect(out).toMatch(/never mock a module|do not mock a module|only mock (a )?module/i);
  });

  it('says installed-is-not-used — the precise inference that failed', () => {
    // The mocked module was a plausible peer dependency. Being installable, or installed,
    // says nothing about whether this code path calls it.
    const out = renderPrompt();
    expect(out).toMatch(/is not proof|does not mean|not the same as/i);
  });

  it('tells it what to do when the module is not reached, instead of guessing', () => {
    // Without an exit, "prove it" becomes "prove it or invent something" — the same shape
    // as the detective's "say so and revise your hypothesis".
    const out = renderPrompt();
    expect(out).toMatch(/do not mock it|mock it at all|without mocking/i);
  });

  it('names no package, framework or ticket of its own', () => {
    const out = renderPrompt();
    for (const lit of ['node-fetch', 'contentstack', 'Contentstack', 'AMSD', 'metrolinx', 'axios']) {
      expect(out, `the prompt hardcodes '${lit}'`).not.toContain(lit);
    }
  });
});

describe('the fix is not inert', () => {
  it('the project prompt and its template carry the same body', () => {
    // prompt-library renders the PROJECT copy and never the template. Editing one and not
    // the other ships a fix that no agent ever sees — which is exactly what happened to
    // blocker-discipline before it was caught.
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8')).body;
    const p = JSON.parse(readFileSync(PROJECT_PROMPT, 'utf8')).body;
    expect(p, 'template and project prompt have drifted').toBe(t);
  });

  it('both declare every placeholder their body uses', () => {
    for (const f of [TEMPLATE, PROJECT_PROMPT]) {
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect(used, `${f} placeholder declaration is out of sync`)
        .toEqual([...doc.placeholders].sort());
    }
  });
});
