/**
 * THE GATE THAT SHOULD HAVE EXISTED.
 *
 * A sweep already claimed to enforce "no stack facts in the engine". It reads *.sh and nothing
 * else — `readdirSync(SCRIPTS)` filtered on `f.endsWith('.sh')`, twice. So the 30,128
 * characters of agent-facing prose inside spec-mode-runner.js were never scanned once, and
 * progress on removing engine prose was reported against a gate blind to the largest offender.
 * A gate whose coverage is narrower than its claim is worse than no gate: it converts an
 * unexamined area into a green tick.
 *
 * THIS SWEEP SCANS BOTH LANGUAGES, because the prose is written in both:
 *   - JS  — template literals (`...`), e.g. the detective's entire contract
 *   - Sh  — heredocs (<<'EOF' ... EOF)
 *
 * Extraction is per-language ON PURPOSE. A first pass matched backticks in shell too and
 * reported 631,580 characters — backticks are command substitution there, so the match spanned
 * unrelated code and inflated the answer 15x. A coarse sweep that overcounts is not a
 * conservative sweep; it is an unusable one, and it gets ignored.
 *
 * WHAT COUNTS AS PROSE. Text addressed to a model — second person, imperatives, output
 * contracts. Not log lines, not error messages, not comments. The test asserts its own
 * extractor still finds the known offenders, so it cannot pass by finding nothing.
 *
 * INTENTIONALLY RED while the migration to lib/prompt-catalog.js proceeds. The budget below
 * is a RATCHET: it may only ever be lowered. Raising it to make the suite green is the failure
 * this file exists to make visible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

/** Second person, imperative, or an output contract — the shape of an instruction to a model. */
const ADDRESSED_TO_A_MODEL = /\b(You are|You MUST|Your job|Your answer|Do NOT|is REQUIRED|Output ONLY|CRITICAL)\b/;

/** JS template literals, escapes respected so an embedded backtick does not end the match. */
function jsProse(src: string): string[] {
  return [...src.matchAll(/`[^`\\]*(?:\\.[^`\\]*)*`/g)]
    .map((m) => m[0])
    .filter((l) => l.length > 200 && ADDRESSED_TO_A_MODEL.test(l));
}

/** Shell heredocs. Backticks in shell are command substitution and must NOT be matched. */
function shProse(src: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  let tag: string | null = null;
  for (const line of src.split('\n')) {
    if (cur === null) {
      const m = line.match(/<<-?['"]?([A-Z][A-Z0-9_]*)['"]?\s*$/);
      if (m) { tag = m[1]; cur = []; }
    } else if (line.trim() === tag) {
      const body = cur.join('\n');
      if (body.length > 200 && ADDRESSED_TO_A_MODEL.test(body)) out.push(body);
      cur = null; tag = null;
    } else {
      cur.push(line);
    }
  }
  return out;
}

type Row = { file: string; blocks: number; chars: number };

function sweep(): Row[] {
  const rows: Row[] = [];
  for (const dir of [SCRIPTS, join(SCRIPTS, 'lib')]) {
    for (const f of readdirSync(dir)) {
      if (!/\.(js|sh)$/.test(f)) continue;
      // Scaffold generators WRITE a project; naming a stack there is the job, not a leak.
      if (/^scaffold-/.test(f) || /^mock/.test(f)) continue;
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      const src = readFileSync(p, 'utf8');
      const blocks = f.endsWith('.js') ? jsProse(src) : shProse(src);
      const chars = blocks.reduce((a, b) => a + b.length, 0);
      if (chars) rows.push({ file: p.replace(ROOT, ''), blocks: blocks.length, chars });
    }
  }
  return rows.sort((a, b) => b.chars - a.chars);
}

/**
 * THE RATCHET. Measured 2026-08-11 at 40,228 characters across 5 files.
 * Lower it as sections move to the catalog. Never raise it.
 */
const BUDGET = 40228;

describe('the sweep can see prose — otherwise it passes vacuously', () => {
  it('the extractor finds the known offender', () => {
    const rows = sweep();
    const runner = rows.find((r) => r.file.endsWith('spec-mode-runner.js'));
    expect(runner, 'the largest prose file was not detected — the extractor is broken').toBeDefined();
    expect(runner!.chars).toBeGreaterThan(1000);
  });

  it('it does NOT treat shell command substitution as a string literal', () => {
    // The 15x-inflation bug: backticks in shell are not template literals.
    const fixture = 'echo "`date`"\n' + 'x=`ls`\n'.repeat(50);
    expect(shProse(fixture)).toEqual([]);
  });

  it('it ignores prose that is not addressed to a model', () => {
    const fixture = ['cat <<EOF', 'x'.repeat(400), 'EOF'].join('\n');
    expect(shProse(fixture), 'a long non-instruction block was counted as a prompt').toEqual([]);
  });
});

describe('THE DEFECT CLASS: agent instructions are data, not code', () => {
  it('engine prose stays within the ratchet and only ever shrinks', () => {
    const rows = sweep();
    const total = rows.reduce((a, r) => a + r.chars, 0);
    const detail = rows.map((r) => `  ${String(r.chars).padStart(6)}  ${r.blocks} block(s)  ${r.file}`).join('\n');
    expect(
      total,
      `agent-facing prose compiled into the engine grew past the ratchet.\n${detail}\n` +
      'Move sections to the project catalog via lib/prompt-catalog.js and LOWER the budget. ' +
      'Raising it is the failure this test exists to make visible.',
    ).toBeLessThanOrEqual(BUDGET);
  });

  it('the budget is a ratchet: it is not satisfied by an empty sweep', () => {
    // If the extractor ever silently stops matching, `total <= BUDGET` passes while proving
    // nothing. This is the guard against that vacuous pass.
    expect(sweep().length, 'the sweep found no files at all — extraction has broken').toBeGreaterThan(0);
  });
});

describe('the prompt layer exists and refuses to invent words', () => {
  it('a prompt layer is present', () => {
    expect(() => require(join(SCRIPTS, 'lib/prompt-catalog.js'))).not.toThrow();
  });

  it('a missing section throws rather than rendering a prompt without it', () => {
    const { renderSection } = require(join(SCRIPTS, 'lib/prompt-catalog.js'));
    expect(() => renderSection({ sections: {}, source: 'test' }, 'nope.missing', {}))
      .toThrow(/not in the catalog/);
  });
});
