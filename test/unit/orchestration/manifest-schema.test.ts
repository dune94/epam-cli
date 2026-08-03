/**
 * Manifest schema — Pydantic model as the single source of truth, JSON Schema
 * generated from it, ajv validating in-process at the JS seam.
 *
 * WHY A SCHEMA AND NOT A TEST: every failure this closes was an ASSERTION WITHOUT
 * VERIFICATION — a path asserted to exist, a search result asserted to be a contract.
 * A test catches those after they are written. A schema makes them unconstructible.
 *
 * PROVENANCE IN THE TYPE is the load-bearing idea: `ResolvedPath` cannot be built
 * without `verified_against`, so the value carries the evidence of its own derivation.
 * A `FixSite` therefore CANNOT hold an unresolved path — which is exactly the live
 * 2026-08-03 failure, where the detective's root-cause file resolved on only one of
 * three codelines (ContentstackContext.tsx / .ts / contentstackContext.tsx) and the
 * writer on the other two was handed a path that did not exist.
 *
 * A `Candidate` is a DIFFERENT TYPE that may hold an unresolved path — a ranked
 * search hit is a guess. Because the types differ, a candidate can never reach the
 * "you must actually write to them" retry prompt.
 *
 * Zero LLM/agent calls: real temp repos, real python, real ajv. Deterministic.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PY = join(REPO_ROOT, 'orchestrations/scripts/.venv/bin/python');
const MODEL = join(REPO_ROOT, 'orchestrations/scripts/lib/story_manifest_schema.py');
const GENERATED_SCHEMA = join(REPO_ROOT, 'orchestrations/config/manifest.schema.json');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run a snippet against the real model. Returns {ok, out, err}. */
function py(snippet: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(PY, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts/lib'))})\n${snippet}`], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** A codeline checkout containing exactly the given files. */
function makeRepo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'manifest-'));
  cleanupDirs.push(root);
  for (const f of files) {
    const full = join(root, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// fixture\n');
  }
  return root;
}

describe('manifest_schema — provenance in the type', () => {
  it('the model module exists and imports', () => {
    expect(existsSync(MODEL)).toBe(true);
    const r = py('import story_manifest_schema; print("ok")');
    expect(r.err).toBe('');
    expect(r.out).toBe('ok');
  });

  it('ResolvedPath cannot be constructed without evidence of its own resolution', () => {
    const r = py(`
import story_manifest_schema as m
try:
    m.ResolvedPath(kind="resolved", declared="a.ts", actual="a.ts", match="exact")
    print("CONSTRUCTED")
except Exception:
    print("REFUSED")
`);
    expect(r.out).toBe('REFUSED'); // verified_against is required
  });

  it('a FixSite REFUSES an unresolved path — the live failure becomes unconstructible', () => {
    const r = py(`
import story_manifest_schema as m
u = m.UnresolvedPath(kind="unresolved", declared="src/context/X.tsx",
                     candidates_checked=["src/context/X.tsx"], reason="not found")
try:
    m.FixSite(path=u, reason="root cause")
    print("CONSTRUCTED")
except Exception:
    print("REFUSED")
`);
    expect(r.out).toBe('REFUSED');
  });

  it('a Candidate ACCEPTS an unresolved path — a ranked guess is allowed to be wrong', () => {
    const r = py(`
import story_manifest_schema as m
u = m.UnresolvedPath(kind="unresolved", declared="src/maybe.ts",
                     candidates_checked=["src/maybe.ts"], reason="not found")
c = m.Candidate(path=u, source="codegraph", rank=1)
print(c.path.kind)
`);
    expect(r.out).toBe('unresolved');
  });
});

describe('resolve_path — discovery against a real checkout, no convention assumed', () => {
  it('exact match', () => {
    const repo = makeRepo(['src/context/Widget.tsx']);
    const r = py(`
import story_manifest_schema as m, json
p = m.resolve_path("src/context/Widget.tsx", ${JSON.stringify(repo)})
print(json.dumps({"kind": p.kind, "match": getattr(p, "match", None), "actual": getattr(p, "actual", None)}))
`);
    const v = JSON.parse(r.out);
    expect(v.kind).toBe('resolved');
    expect(v.match).toBe('exact');
  });

  it('case variant — the live metrolinx case', () => {
    const repo = makeRepo(['src/context/widgetContext.tsx']);
    const r = py(`
import story_manifest_schema as m, json
p = m.resolve_path("src/context/WidgetContext.tsx", ${JSON.stringify(repo)})
print(json.dumps({"kind": p.kind, "match": getattr(p, "match", None), "actual": getattr(p, "actual", None)}))
`);
    const v = JSON.parse(r.out);
    expect(v.kind).toBe('resolved');
    expect(v.match).toBe('case_variant');
    expect(v.actual).toBe('src/context/widgetContext.tsx');
  });

  it('extension variant — the live upexpress case (.tsx declared, .ts real)', () => {
    const repo = makeRepo(['src/context/WidgetContext.ts']);
    const r = py(`
import story_manifest_schema as m, json
p = m.resolve_path("src/context/WidgetContext.tsx", ${JSON.stringify(repo)})
print(json.dumps({"kind": p.kind, "match": getattr(p, "match", None), "actual": getattr(p, "actual", None)}))
`);
    const v = JSON.parse(r.out);
    expect(v.kind).toBe('resolved');
    expect(v.match).toBe('extension_variant');
    expect(v.actual).toBe('src/context/WidgetContext.ts');
  });

  it('genuinely absent → unresolved WITH the candidates it checked, never a false pass', () => {
    const repo = makeRepo(['src/other.ts']);
    const r = py(`
import story_manifest_schema as m, json
p = m.resolve_path("src/context/Widget.tsx", ${JSON.stringify(repo)})
print(json.dumps({"kind": p.kind, "checked": len(p.candidates_checked) if p.kind=="unresolved" else 0}))
`);
    const v = JSON.parse(r.out);
    expect(v.kind).toBe('unresolved');
    expect(v.checked).toBeGreaterThan(0);
  });
});

describe('StoryManifest — per-codeline by construction', () => {
  it('a flat shared file list is not expressible; keys must match the story codelines', () => {
    const r = py(`
import story_manifest_schema as m
cm = m.CodelineManifest(codeline="alpha")
try:
    m.StoryManifest(story_id="X-1", codelines=["alpha","beta"], per_codeline={"alpha": cm})
    print("CONSTRUCTED")
except Exception:
    print("REFUSED")
`);
    expect(r.out).toBe('REFUSED'); // beta missing
  });

  it('accepts a manifest whose per-codeline keys exactly cover the story codelines', () => {
    const r = py(`
import story_manifest_schema as m
per = {c: m.CodelineManifest(codeline=c) for c in ("alpha","beta")}
sm = m.StoryManifest(story_id="X-1", codelines=["alpha","beta"], per_codeline=per)
print(sorted(sm.per_codeline.keys()))
`);
    expect(r.out).toContain('alpha');
    expect(r.out).toContain('beta');
  });
});

describe('generated JSON Schema is the wire contract for the JS/bash consumers', () => {
  it('is committed and is regenerable from the model without drift', () => {
    expect(
      existsSync(GENERATED_SCHEMA),
      'orchestrations/config/manifest.schema.json must be generated from the model and committed',
    ).toBe(true);
    const fresh = py('import story_manifest_schema, json; print(json.dumps(story_manifest_schema.json_schema(), sort_keys=True))');
    expect(fresh.err).toBe('');
    const committed = JSON.stringify(JSON.parse(readFileSync(GENERATED_SCHEMA, 'utf8')), Object.keys(JSON.parse(fresh.out)).sort());
    // Compare semantically: regenerate and diff against the committed artifact.
    expect(
      JSON.parse(fresh.out),
      'the committed schema has drifted from the Pydantic model — regenerate it; never hand-edit',
    ).toEqual(JSON.parse(JSON.stringify(JSON.parse(readFileSync(GENERATED_SCHEMA, 'utf8')))));
    expect(committed.length).toBeGreaterThan(0);
  });

  it('ajv accepts a valid manifest and REJECTS a FixSite holding an unresolved path', async () => {
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(GENERATED_SCHEMA, 'utf8')));

    const good = {
      story_id: 'X-1',
      codelines: ['alpha'],
      per_codeline: {
        alpha: {
          codeline: 'alpha',
          fix_sites: [
            {
              path: { kind: 'resolved', declared: 'a.ts', actual: 'a.ts', match: 'exact', verified_against: '/tmp/x' },
              reason: 'root cause',
            },
          ],
          candidates: [],
          deliverables: [],
        },
      },
    };
    expect(validate(good), JSON.stringify(validate.errors)).toBe(true);

    const bad = JSON.parse(JSON.stringify(good));
    bad.per_codeline.alpha.fix_sites[0].path = {
      kind: 'unresolved',
      declared: 'a.ts',
      candidates_checked: ['a.ts'],
      reason: 'missing',
    };
    expect(validate(bad), 'schema must reject an unresolved path in a fix site').toBe(false);
  });
});
