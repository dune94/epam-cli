/**
 * The dependency manifest is generated and reviewed, never hand-written.
 *
 * Today's manifest is hand-maintained, and it shows: `ignorePackages` carries
 * "src" and "tests" among the Node builtins — someone listing internal
 * directory names one at a time, who never reached components/api/interface.
 * That omission cost three lanes their story budget on 2026-07-29 (346/553/506
 * phantom installs). Nothing generates the file: every reference to
 * dependency-check.json outside the config itself is a test.
 *
 * So a detector agent emits it per codeline at pre-flight, and a reviewer
 * validates it before anything depends on it. This file covers the two
 * deterministic halves that the agent and reviewer are built on:
 *
 *   THE SCHEMA — pydantic, compiled to JSON Schema and bound at the provider
 *   via EPAM_RESPONSE_SCHEMA. Arrays carry min_length because a schema that
 *   permits saying nothing is not a contract: openspec is already tool-bound
 *   with `required: ['acceptanceCriteria']` and still returned [] repeatedly,
 *   which is structurally valid and useless. An empty scanFileExtensions would
 *   silently disable scanning entirely.
 *
 *   THE REVIEW — mechanical checks against the real codeline, so a plausible
 *   but wrong manifest is rejected before the run rather than discovered by a
 *   loop 500 installs deep.
 *
 * The agent invocation itself is glue over these two; they are where the
 * correctness lives, and they are testable without spending a model call.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PY = join(REPO_ROOT, 'orchestrations/scripts/.venv/bin/python');
const SCHEMA_PY = join(REPO_ROOT, 'orchestrations/scripts/lib/manifest_schema.py');
const CONFIG_DIR = join(REPO_ROOT, 'orchestrations/projects/metrolinx');

function py(args: string[], stdin?: string) {
  const r = spawnSync(PY, [SCHEMA_PY, ...args], { encoding: 'utf8', input: stdin, timeout: 60000 });
  return { rc: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function schema(): Record<string, unknown> {
  const r = py(['--print-schema']);
  expect(r.rc, `--print-schema failed:\n${r.err}`).toBe(0);
  return JSON.parse(r.out);
}

/** Validate a manifest against a repo. Returns the reviewer verdict. */
function review(manifest: unknown, repo: string) {
  const r = py(['--validate', '--repo', repo], JSON.stringify(manifest));
  const parsed = r.out ? JSON.parse(r.out) : { verdict: 'fail', issues: ['no output'] };
  return { rc: r.rc, ...parsed } as { rc: number; verdict: string; issues: string[] };
}

const GOOD = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies', 'devDependencies'],
  scanFileExtensions: ['.ts', '.tsx'],
  importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
  installCommand: 'npm install --no-save {package}',
  vendorDirs: ['node_modules'],
};

function repoFixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'manifest-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(d, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return d;
}

describe('the schema is a real contract, not a shape suggestion', () => {
  it('publishes a JSON Schema', () => {
    const s = schema();
    expect(s).toHaveProperty('name');
    expect(s).toHaveProperty('schema');
  });

  it('requires every field the scanner depends on', () => {
    const inner = (schema().schema as Record<string, unknown>);
    const required = inner.required as string[];
    for (const k of ['manifestFile', 'manifestKeys', 'scanFileExtensions', 'importPattern', 'installCommand', 'vendorDirs']) {
      expect(required, `${k} is optional — the scanner cannot run without it`).toContain(k);
    }
  });

  it('forbids EMPTY arrays — the openspec failure, structurally prevented', () => {
    // `required` alone permits []. An empty scanFileExtensions disables
    // scanning silently; an empty manifestKeys makes every dep undeclared.
    const props = ((schema().schema as Record<string, unknown>).properties) as Record<string, { type?: string; minItems?: number }>;
    for (const k of ['manifestKeys', 'scanFileExtensions', 'vendorDirs']) {
      expect(props[k]?.minItems, `${k} permits an empty array`).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    const inner = schema().schema as Record<string, unknown>;
    expect(inner.additionalProperties, 'a typo in a field name would be silently dropped').toBe(false);
  });
});

describe('the reviewer checks the manifest against the actual repo', () => {
  it('passes a correct manifest', () => {
    const repo = repoFixture({
      'package.json': '{"name":"x"}',
      'node_modules/dep/index.js': '1',
      'src/a.ts': "import y from 'left-pad';\n",
      'package-lock.json': '{}',
    });
    const v = review(GOOD, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(v.verdict, `issues: ${JSON.stringify(v.issues)}`).toBe('pass');
  });

  it('rejects a manifestFile that does not exist in the codeline', () => {
    const repo = repoFixture({ 'src/a.ts': 'export const a=1;\n' });
    const v = review(GOOD, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/manifestFile/i);
  });

  it('rejects an importPattern that does not compile', () => {
    const repo = repoFixture({ 'package.json': '{}', 'src/a.ts': 'x' });
    const v = review({ ...GOOD, importPattern: '([unclosed' }, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/importPattern/i);
  });

  it('rejects an importPattern that matches nothing in the real sources', () => {
    // Compiles, but finds no imports — the scanner would report a codeline with
    // zero dependencies and nobody would notice.
    const repo = repoFixture({
      'package.json': '{}',
      'src/a.ts': "import y from 'left-pad';\n",
    });
    const v = review({ ...GOOD, importPattern: 'ZZZ_NEVER_MATCHES_(\\w+)' }, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/matched no imports|importPattern/i);
  });

  it('rejects extensions that do not occur in the codeline', () => {
    const repo = repoFixture({ 'package.json': '{}', 'src/a.ts': 'x' });
    const v = review({ ...GOOD, scanFileExtensions: ['.rb'] }, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(v.verdict).toBe('fail');
    expect(v.issues.join(' ')).toMatch(/scanFileExtensions|\.rb/i);
  });

  it('gives a failing verdict at least one actionable issue', () => {
    // An empty issues array makes a rejection irreversible — the regenerate
    // loop has nothing to correct. Same rule prd-change-reviewer already states.
    const repo = repoFixture({ 'src/a.ts': 'x' });
    const v = review(GOOD, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(v.issues.length, 'fail with no issues gives the retry nothing to fix').toBeGreaterThan(0);
  });
});

describe('the existing hand-written manifest is valid for the real codelines', () => {
  // Until the detector replaces it, this is what the pipeline actually uses —
  // and it is the baseline the generated one must at least match.
  const cfg = join(CONFIG_DIR, 'dependency-check.json');
  const codelines = ['next.gotransit.com', 'next.upexpress.com', 'next.metrolinx.com']
    .map((n) => `/home/bradleyjerome/projects/metrolinx/${n}`)
    .filter((p) => existsSync(p));

  it.skipIf(codelines.length === 0)('validates against every codeline', () => {
    const manifest = JSON.parse(readFileSync(cfg, 'utf8'));
    for (const repo of codelines) {
      const v = review(manifest, repo);
      expect(v.verdict, `${repo}: ${JSON.stringify(v.issues)}`).toBe('pass');
    }
  });
});
