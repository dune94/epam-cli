/**
 * Every Python schema in lib/ must actually RUN.
 *
 * THE DEFECT (found 2026-08-04). Three files import pydantic:
 *   manifest_schema.py, kb_schema.py, story_manifest_schema.py
 * pydantic was never installed and never declared as a dependency. All three crashed on
 * import with ModuleNotFoundError. They had existed for some time, looked like
 * validation, and validated nothing — because nothing ever executed them.
 *
 * story_manifest_schema.py was written earlier the SAME DAY, described as a Pydantic
 * model with provenance-in-type design, committed, and never run once. The tests written
 * beside it passed because they exercised the JavaScript producer instead. A single
 * `python3 story_manifest_schema.py` would have failed instantly.
 *
 * This is the same shape as every other defect in this investigation: an artefact that
 * looks like enforcement, is never executed, and therefore enforces nothing — the spec
 * reviewer that could not block, the 92 tests that grepped source, the needs_review
 * verdict nothing branched on.
 *
 * So: EXECUTE each one. Not import-check, not grep — run the file and require it to
 * start. A missing dependency must fail HERE, loudly, in the test suite, rather than
 * silently disabling a validator in a live run.
 *
 * Discovers the files by convention. A new schema added to lib/ is covered automatically;
 * there is no list to forget to update.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib');

/** Every Python file in lib/ that declares a third-party import. */
function pythonSchemas(): string[] {
  return readdirSync(LIB)
    .filter((f) => f.endsWith('.py'))
    .filter((f) => /^\s*(from|import)\s+pydantic/m.test(readFileSync(join(LIB, f), 'utf8')));
}

describe('the declared Python dependency is real', () => {
  it('requirements.txt exists and names pydantic', () => {
    const req = join(REPO_ROOT, 'requirements.txt');
    expect(
      existsSync(req),
      'schema files import pydantic with no dependency manifest — the next machine to ' +
        'run this pipeline gets validators that crash on import and validate nothing',
    ).toBe(true);
    expect(readFileSync(req, 'utf8')).toMatch(/pydantic/);
  });

  it('pydantic is importable by the SAME interpreter the pipeline invokes', () => {
    // The pipeline calls plain `python3` (run-agent-orchestration.sh:1315). A venv the
    // scripts never activate would not help.
    const r = spawnSync('python3', ['-c', 'import pydantic; print(pydantic.VERSION)'], {
      encoding: 'utf8', timeout: 30000,
    });
    expect(
      r.status,
      'python3 cannot import pydantic, so every schema validator in lib/ is dead code:\n' +
        `${r.stderr}`,
    ).toBe(0);
  });
});

describe('every pydantic schema in lib/ executes', () => {
  it('finds the schema files (guard against a vacuous pass)', () => {
    expect(
      pythonSchemas().length,
      'no pydantic-importing files were discovered, so the assertions below prove nothing',
    ).toBeGreaterThan(0);
  });

  it.each(pythonSchemas())('%s runs without crashing on import', (file) => {
    const r = spawnSync('python3', [join(LIB, file)], {
      encoding: 'utf8', timeout: 30000, input: '',
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    expect(
      out,
      `${file} crashed on import. It looks like a validator and validates nothing — ` +
        'exactly the failure class this suite exists to catch.',
    ).not.toMatch(/ModuleNotFoundError|ImportError|Traceback/);
  });

  it.each(pythonSchemas())('%s does not exit with an import-time error code', (file) => {
    const r = spawnSync('python3', [join(LIB, file), '--print-schema'], {
      encoding: 'utf8', timeout: 30000, input: '',
    });
    // A usage error (2) is fine — the file ran. A traceback is not.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/ModuleNotFoundError|Traceback/);
  });
});
