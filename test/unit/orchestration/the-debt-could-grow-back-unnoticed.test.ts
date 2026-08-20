// EIGHT OF TEN CONFIRMED DEFECTS WERE HARDCODING, AND EVERY ONE PASSED THE PRE-FLIGHT THAT EXISTED.
//
// 2026-08-20. Ten defects were confirmed by execution; eight were literals baked into code where a
// data or template layer already owned the value. None was catchable by any check in the suite,
// because nothing counted them — so the number could only grow, one plausible commit at a time.
//
// Phase 0 is not a fix for any of the eight. It is the floor: two RATCHETS whose counts may only
// go down, and a REGISTER of operator decisions that live in data and become fatal when the
// operator says so. Nothing here decides what belongs on a list.
//
// These tests EXECUTE the scanners against fixtures on disk and assert on what they emit. A test
// that read the scanner source for the word "ratchet" would pass on a comment.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const H = join(ROOT, 'orchestrations/scripts/lib/handlers');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function run(script: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(NODE, [join(H, script), ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

/** A repo-shaped fixture with a data layer and a code file. */
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'ratchet-')); made.push(d);
  mkdirSync(join(d, 'orchestrations/prompts/templates'), { recursive: true });
  mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
  mkdirSync(join(d, 'orchestrations/scripts/lib'), { recursive: true });
  mkdirSync(join(d, 'test'), { recursive: true });
  return d;
}

describe('literal ratchet: code restating a value the data layer owns', () => {
  it('FLAGS a literal copied out of a template', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/prompts/templates/t.json'),
      JSON.stringify({ id: 'thing', body: 'the codeline declares no typecheck command' }));
    writeFileSync(join(d, 'orchestrations/scripts/x.sh'),
      `msg="the codeline declares no typecheck command"\n`);
    const r = run('scan-duplicated-literals.js', [d]);
    expect(r.out).toMatch(/x\.sh:1/);
  });

  it('does NOT flag naming a template by its id — code must address what it renders', () => {
    // 141 of the first run's 272 "findings" were exactly this. A reference is not a copy.
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/prompts/templates/t.json'),
      JSON.stringify({ id: 'repro-test-writer', body: 'some prose that is long enough' }));
    writeFileSync(join(d, 'orchestrations/scripts/x.sh'),
      `render_engine_prompt "repro-test-writer" OUT\n`);
    expect(run('scan-duplicated-literals.js', [d]).out.trim()).toBe('');
  });

  it('does NOT flag a placeholder or env-var NAME', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/config/c.json'),
      JSON.stringify({ key: '__MANIFEST_FILE__', other: 'LANGFUSE_BASE_URL' }));
    writeFileSync(join(d, 'orchestrations/scripts/x.sh'),
      `jq --arg a "__MANIFEST_FILE__" --arg b "LANGFUSE_BASE_URL" .\n`);
    expect(run('scan-duplicated-literals.js', [d]).out.trim()).toBe('');
  });

  it('does NOT flag a comment that quotes the value', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/prompts/templates/t.json'),
      JSON.stringify({ id: 't', body: 'a sentence the data layer owns' }));
    writeFileSync(join(d, 'orchestrations/scripts/x.sh'),
      `# see "a sentence the data layer owns" in t.json\n`);
    expect(run('scan-duplicated-literals.js', [d]).out.trim()).toBe('');
  });

  it('finds the real one in THIS repo — a scan that finds nothing proves nothing', () => {
    const r = run('scan-duplicated-literals.js', [ROOT]);
    expect(r.out, 'the scanner reported nothing against the live repo').toMatch(/review output unparseable/);
  });
});

describe('guard calibration: a blocking function no test names', () => {
  it('FLAGS a guard that returns non-zero and appears in no test', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/scripts/g.sh'),
      `wholly_untested_guard() {\n  [ -f x ] || return 1\n}\n`);
    writeFileSync(join(d, 'test/some.test.ts'), `// nothing\n`);
    expect(run('scan-uncalibrated-guards.js', [d]).out).toMatch(/wholly_untested_guard/);
  });

  it('does NOT flag one a test names', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/scripts/g.sh'),
      `covered_guard() {\n  [ -f x ] || return 1\n}\n`);
    writeFileSync(join(d, 'test/some.test.ts'), `it('covered_guard blocks', () => {});\n`);
    expect(run('scan-uncalibrated-guards.js', [d]).out).not.toMatch(/covered_guard/);
  });

  it('does NOT flag a function that cannot block', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/scripts/g.sh'),
      `just_logs() {\n  echo "$1"\n}\n`);
    writeFileSync(join(d, 'test/some.test.ts'), `// nothing\n`);
    expect(run('scan-uncalibrated-guards.js', [d]).out.trim()).toBe('');
  });
});

describe('the register: operator decisions, enforced from data', () => {
  const withRegister = (entry: object): string => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/scripts/lib/target.sh'), `x="the banned phrase here"\n`);
    writeFileSync(join(d, 'orchestrations/config/remediation-register.json'),
      JSON.stringify({ bannedLiterals: [entry], uselessGuards: [] }));
    return d;
  };

  it('enforce:true on a literal that is still present FAILS', () => {
    const d = withRegister({ id: 'L-X', file: 'orchestrations/scripts/lib/target.sh', pattern: 'the banned phrase here', reason: 'r', enforce: true });
    const r = run('check-remediation-register.js', [d]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/L-X/);
  });

  it('enforce:false on the same literal PASSES — catalogued, not fatal', () => {
    const d = withRegister({ id: 'L-X', file: 'orchestrations/scripts/lib/target.sh', pattern: 'the banned phrase here', reason: 'r', enforce: false });
    expect(run('check-remediation-register.js', [d]).status).toBe(0);
  });

  it('an enforced guard still present FAILS', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/scripts/lib/target.sh'), `useless_guard() { return 1; }\n`);
    writeFileSync(join(d, 'orchestrations/config/remediation-register.json'),
      JSON.stringify({ bannedLiterals: [], uselessGuards: [{ id: 'G-X', file: 'orchestrations/scripts/lib/target.sh', symbol: 'useless_guard', reason: 'r', enforce: true }] }));
    const r = run('check-remediation-register.js', [d]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/G-X/);
  });

  it('an UNREADABLE register fails — absence is never success', () => {
    const d = fixture();   // no register written at all
    expect(run('check-remediation-register.js', [d]).status).toBe(2);
  });

  it('an enforced entry pointing at a deleted file is reported, not silently retired', () => {
    const d = fixture();
    writeFileSync(join(d, 'orchestrations/config/remediation-register.json'),
      JSON.stringify({ bannedLiterals: [{ id: 'L-GONE', file: 'orchestrations/scripts/vanished.sh', pattern: 'x', enforce: true }], uselessGuards: [] }));
    const r = run('check-remediation-register.js', [d]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/stale/);
  });

  it("the repo's own register is readable and currently enforces nothing", () => {
    // Seeded entries all start enforce:false, so Phase 0 changes no behaviour until the operator
    // decides it does. If this ever fails, someone flipped a flag — which is the point.
    expect(run('check-remediation-register.js', [ROOT]).status).toBe(0);
  });
});

describe('the baselines file is real', () => {
  it('declares a number for every ratchet the pre-flight runs', () => {
    const j = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/preflight-baselines.json'), 'utf8'));
    expect(typeof j.duplicatedLiterals).toBe('number');
    expect(typeof j.uncalibratedGuards).toBe('number');
  });

  it('and the pre-flight actually calls both scanners', () => {
    const s = readFileSync(join(ROOT, 'orchestrations/scripts/preflight-static.sh'), 'utf8');
    expect(s).toMatch(/scan-duplicated-literals\.js/);
    expect(s).toMatch(/scan-uncalibrated-guards\.js/);
    expect(s).toMatch(/check-remediation-register\.js/);
  });
});
