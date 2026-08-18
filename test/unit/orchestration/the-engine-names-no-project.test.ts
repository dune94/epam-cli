/**
 * THE ENGINE NAMES NO PROJECT.
 *
 * Operator rule, 2026-08-15: ONE generic pipeline serves every project — mock3, metrolinx,
 * any client codeline — and onboarding a project requires ZERO pipeline changes. A project
 * is DATA: a config dir, a PRD, codeline paths, a manifest.
 *
 * The engine is already neutral about metrolinx, gotransit and upexpress — not one
 * executable line names them. But four sites still fall back to a project-named artefact,
 * all inherited from the first project this engine ever ran:
 *
 *   run-agent-orchestration.sh   PRD fallback on the RUN PATH
 *   synthesize-prd-from-jira.js  default canonical template — the "borrowed identity" defect
 *   generate-qa-report.sh        PRD path
 *   generate-run-narrative.sh    PRD path
 *
 * WHY A FALLBACK IS WORSE THAN AN ERROR HERE. A default that names another project does not
 * fail when it is wrong — it succeeds against the wrong data. ingest-jira-tickets.sh already
 * carries the scar in its own error text: an ingest for ANY Jira project silently overwrote
 * that one project's PRD. preflight-check.sh warns that a project without its own canonical
 * "will inherit ANOTHER project's identity", which is a warning about a fallback that still
 * exists. Absent must be an error, not a substitution.
 *
 * These tests read source deliberately: the assertion is that a literal does not appear
 * anywhere in the engine, which is a property of the text, not of one execution path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/** Every engine file, excluding the per-project launchers, which ARE per project. */
function engineFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(sh|js)$/.test(e)) continue;
      if (/^tier3-[a-z0-9-]+-run\.sh$/.test(e)) continue;   // a launcher per project is the design
      if (/^run-[a-z0-9-]+-test\.sh$/.test(e)) continue;    // ditto, per-project test drivers
      out.push(p);
    }
  };
  walk(SCRIPTS);
  return out;
}

/** Executable lines only — a live-failure story in a comment is evidence, not a dependency. */
function codeLinesNaming(literal: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const f of engineFiles()) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const t = text.trim();
      if (t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (literal.test(text)) hits.push({ file: f.replace(SCRIPTS, ''), line: i + 1, text: t.slice(0, 120) });
    });
  }
  return hits;
}

describe('no project name is baked into the engine', () => {
  it('is not vacuous — the walker actually finds engine files', () => {
    const files = engineFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('run-agent-orchestration.sh'))).toBe(true);
  });

  it('names no current project', () => {
    // Already true; this pins it so a future fix cannot reintroduce one.
    const hits = codeLinesNaming(/metrolinx|gotransit|upexpress/i);
    expect(hits.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  });

  it('names no historical project either — including in a fallback', () => {
    // A fallback naming a project does not fail when it is wrong; it succeeds against the
    // wrong data, which is how one project's PRD got overwritten by an unrelated ingest.
    const hits = codeLinesNaming(/travel-app|skyscanner|hello-dolly/i);
    expect(hits.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  });
});

describe('a missing PRD is an error, never a substitution', () => {
  it('the orchestration PRD resolution has no project-named default', () => {
    const src = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
    const m = /_synth_prd="\$\{JIRA_SYNTH_PRD_PATH:-[^"]*"/.exec(src);
    expect(m, 'the synth PRD resolution moved — re-point this test').not.toBeNull();
    expect(m![0], 'falls back to a project-named PRD').not.toMatch(/travel-app|metrolinx/i);
  });

  it('PRD synthesis requires a template rather than defaulting to one project\'s', () => {
    const src = readFileSync(join(SCRIPTS, 'synthesize-prd-from-jira.js'), 'utf8');
    // The project's own canonical is resolved from its config dir; there is no built-in.
    expect(src).not.toMatch(/travel-app-prd\.canonical\.json/);
  });
});
