// THE WRITER PROMPT AND THE RETRY AMENDMENT BOTH WENT OUT EMPTY, AND NOTHING SAID SO.
//
// Live metrolinx AMSD-2041, 2026-08-19 16:23. Both gates worked perfectly -- dependency-scan
// blocked 3 times, lockfile-sync blocked 3 times, every verdict correct and precise -- and the
// story still failed, because the one channel carrying those verdicts to the writer was broken:
//
//   claude.sh: line 10339: jq: Argument list too long
//   [render-engine-prompt] FAILED to render 'coordinator-amendment'
//   claude.sh: line  9421: jq: Argument list too long
//   [render-engine-prompt] FAILED to render 'writer-plan-section'
//
// MAX_ARG_STRLEN caps a SINGLE argv entry at 128KB -- not ARG_MAX's 2MB, which is the whole
// vector. `jq -n --arg prompt "$prompt"` passes the entire writer prompt as one entry, so it dies
// at exit 126 the moment the prompt crosses 128KB. Measured here, not assumed: 120KB passes,
// 130KB is 126.
//
// Both call sites assign through bare command substitution, so a dead render degrades to an EMPTY
// STRING rather than a refusal. The amendment silently carried nothing (0 rendered, 2 failed all
// run), and at 9421 the ENTIRE writer prompt went out empty -- visible in the log as attempts that
// returned in 0.01 min with in=0 out=0. The run climbed the whole model ladder to kimi-k3 against
// a wall no model was ever shown.
//
// THE SAME CLASS WAS FIXED ONCE ALREADY, AT ONE SITE (2e2e8b1, contextualize-stories.sh). Fixing
// the site instead of the class left 80 more, so the fix here is one helper with the SAME calling
// syntax as `jq -n`, and a scanner that fails if site 81 ever appears.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/jq-vals.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const bash = (script: string) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** Build a value of exactly `kb` kilobytes with content that would break naive quoting. */
const payload = (kb: number) =>
  `head -c ${kb * 1024} /dev/zero | tr '\\0' 'x'`;

describe('the constraint itself, executed rather than assumed', () => {
  it('jq -n --arg survives 120KB', () => {
    const r = bash(`V=$(${payload(120)}); jq -n --arg v "$V" '{a:$v}' >/dev/null`);
    expect(r.status).toBe(0);
  });

  it('jq -n --arg DIES at 130KB — this is the live defect', () => {
    const r = bash(`V=$(${payload(130)}); jq -n --arg v "$V" '{a:$v}' >/dev/null`);
    expect(r.status, 'the 128KB single-argv cap is gone; this test no longer describes reality')
      .not.toBe(0);
  });
});

describe('jq_vals — the replacement, same calling syntax', () => {
  const src = `source ${JSON.stringify(LIB)}`;

  it('writes a values file at 130KB, where jq -n could not', () => {
    const d = mkdtempSync(join(tmpdir(), 'jqvals-')); made.push(d);
    const out = join(d, 'vals.json');
    const r = bash(`${src}; V=$(${payload(130)}); jq_vals --arg v "$V" '{"__V__":$v}' > ${out}`);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.__V__.length).toBe(130 * 1024);
  });

  it('round-trips content that naive quoting would corrupt', () => {
    const d = mkdtempSync(join(tmpdir(), 'jqvals-rt-')); made.push(d);
    const out = join(d, 'vals.json');
    // quotes, backslashes, newlines, a dollar sign, unicode, and a jq-looking token
    const nasty = 'a"b\\c\nd$e — f `g` $(h) ${i} \t j';
    // The value arrives via a QUOTED heredoc. Interpolating it into the script inside double
    // quotes let bash expand $e, `g` and $(h) before jq_vals ever saw them — the first run of
    // this test failed on that and looked like a helper bug.
    const r = bash(`${src}
V=$(cat <<'EOF_NASTY'
${nasty}
EOF_NASTY
)
jq_vals --arg v "$V" '{"__V__":$v}' > ${out}`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).__V__).toBe(nasty);
  });

  it('handles several large values in one call', () => {
    const d = mkdtempSync(join(tmpdir(), 'jqvals-multi-')); made.push(d);
    const out = join(d, 'vals.json');
    const r = bash(`${src}
      A=$(${payload(130)}); B=$(${payload(140)})
      jq_vals --arg a "$A" --arg b "$B" '{"__A__":$a,"__B__":$b}' > ${out}`);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.__A__.length).toBe(130 * 1024);
    expect(doc.__B__.length).toBe(140 * 1024);
  });

  it('still supports --argjson, including a large one', () => {
    const d = mkdtempSync(join(tmpdir(), 'jqvals-json-')); made.push(d);
    const out = join(d, 'vals.json');
    const r = bash(`${src}
      J=$(jq -nc --argjson n 200000 '[range(0; 20000)]')
      jq_vals --argjson j "$J" --arg s "plain" '{"__J__":$j,"__S__":$s}' > ${out}`);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(Array.isArray(doc.__J__)).toBe(true);
    expect(doc.__J__.length).toBe(20000);
    expect(doc.__S__).toBe('plain');
  });

  it('leaves no temp files behind', () => {
    const d = mkdtempSync(join(tmpdir(), 'jqvals-tmp-')); made.push(d);
    const r = bash(`${src}
      export TMPDIR=${d}
      V=$(${payload(130)}); jq_vals --arg v "$V" '{"__V__":$v}' > /dev/null
      ls ${d} | wc -l`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim(), 'temp files accumulate once per prompt render, every retry')
      .toBe('0');
  });

  it('fails loudly when jq itself fails — never a silent empty file', () => {
    const r = bash(`${src}; jq_vals --arg v "x" 'this is not valid jq(' 2>/dev/null`);
    expect(r.status).not.toBe(0);
  });
});

describe('the class, not the site', () => {
  // 2e2e8b1 fixed exactly this in contextualize-stories.sh and left 80 more behind.
  it('no shell script builds a prompt values file with jq -n --arg', () => {
    const files = bash('ls orchestrations/scripts/*.sh orchestrations/scripts/lib/*.sh')
      .stdout.trim().split('\n');
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/>\s*"\$_[A-Za-z0-9_]*vals[A-Za-z0-9_]*"/.test(lines[i])) continue;
        if (/^\s*#/.test(lines[i])) continue; // a comment is documentation, not a call site
        const block: string[] = [];
        for (let j = i; j >= 0 && j > i - 40; j--) {
          block.unshift(lines[j]);
          if (/^\s*#/.test(lines[j])) continue;
          if (/jq\s+-n/.test(lines[j])) { 
            if (/--arg\b|--argjson\b/.test(block.join('\n'))) offenders.push(`${f}:${j + 1}`);
            break;
          }
        }
      }
    }
    expect(offenders, `these pass unbounded content through a single argv entry:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});

describe('wired, not merely written', () => {
  const callers = () => bash(
    "grep -rln 'jq_vals ' orchestrations/scripts/*.sh | grep -v 'lib/jq-vals.sh'",
  ).stdout.trim().split('\n').filter(Boolean);

  it('found the callers at all', () => {
    expect(callers().length, 'the scan found nothing, so the assertions below prove nothing')
      .toBeGreaterThan(5);
  });

  it('every script that CALLS jq_vals also sources it', () => {
    const unwired = callers().filter(
      (f) => !readFileSync(join(ROOT, f), 'utf8').includes('lib/jq-vals.sh'),
    );
    expect(unwired, `an unsourced jq_vals is command-not-found — it writes NO values file:\n${unwired.join('\n')}`)
      .toEqual([]);
  });

  it('and the sourced path actually resolves from that script', () => {
    for (const f of callers()) {
      const dir = join(ROOT, f, '..');
      const r = bash(`SCRIPT_DIR=${JSON.stringify(dir)}; source "$SCRIPT_DIR/lib/jq-vals.sh" && command -v jq_vals`);
      expect(r.status, `${f}: the source line does not resolve`).toBe(0);
    }
  });
});

// THE TWO TEMPLATES THAT ACTUALLY DIED, rendered through the REAL renderer at a size that
// killed the live run. Without this, the fix is proven only against a synthetic filter.
describe('the live failures, replayed at scale', () => {
  const render = (id: string, bodyKey: string, build: string) => {
    const d = mkdtempSync(join(tmpdir(), 'live-render-')); made.push(d);
    const out = join(d, 'vals.json');
    return bash(`
source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/jq-vals.sh'))}
source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/render-engine-prompt.sh'))}
export NODE_CMD=${JSON.stringify(join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node'))}
BIG=$(${payload(200)})
${build.replace('OUT', out)}
render_engine_prompt ${id} ${out} ${bodyKey}`);
  };

  it("renders 'writer-plan-section' with a 200KB prompt — line 9421", () => {
    const r = render('writer-plan-section', 'execution_plan',
      `jq_vals --arg story_plan "a plan" --arg prompt "$BIG" '{"__STORY_PLAN__":$story_plan,"__PROMPT__":$prompt}' > OUT`);
    expect(r.status, `still dies: ${r.stderr}`).toBe(0);
    expect(r.stdout.length, 'rendered empty — the exact live failure').toBeGreaterThan(200 * 1024);
  });

  it("renders 'coordinator-amendment' with a 200KB verification failure — line 10339", () => {
    const r = render('coordinator-amendment', 'deterministic_check',
      `jq_vals --arg prior_diagnosis_section "" --arg verification_failure "$BIG" --arg existing_amendment "" '{"__PRIOR_DIAGNOSIS_SECTION__":$prior_diagnosis_section,"__VERIFICATION_FAILURE__":$verification_failure,"__EXISTING_AMENDMENT__":$existing_amendment}' > OUT`);
    expect(r.status, `still dies: ${r.stderr}`).toBe(0);
    expect(r.stdout.length, 'the amendment rendered empty — the writer learns nothing').toBeGreaterThan(200 * 1024);
  });
});

describe('the source line is placed where it can work', () => {
  // Both halves were got wrong in one sitting on 2026-08-19. Placed beside SCRIPT_DIR, the line
  // landed INSIDE claude.sh's path-resolution block, which several tests lift verbatim to build a
  // minimal script tree — their probes then died sourcing a library they have no reason to carry.
  // Moved out, one script had SCRIPT_DIR defined LOWER DOWN, so the line ran before it existed and
  // that script died with "SCRIPT_DIR: unbound variable" on every invocation. Neither is caught by
  // `bash -n`, and both are silent until something executes the script.
  const callers = () => bash(
    "grep -rln 'lib/jq-vals.sh' orchestrations/scripts/*.sh | grep -v 'lib/jq-vals.sh'",
  ).stdout.trim().split('\n').filter(Boolean);

  it('sources jq-vals only after SCRIPT_DIR is assigned', () => {
    const bad: string[] = [];
    for (const f of callers()) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
      const decl = lines.findIndex((l) => /^SCRIPT_DIR=/.test(l));
      const use = lines.findIndex((l) => /^source "\$SCRIPT_DIR\/lib\/jq-vals\.sh"/.test(l));
      if (decl >= 0 && use >= 0 && use < decl) bad.push(`${f}: source@${use + 1} before SCRIPT_DIR@${decl + 1}`);
    }
    expect(bad, `these die with "SCRIPT_DIR: unbound variable" before doing anything:\n${bad.join('\n')}`)
      .toEqual([]);
  });

  it('and the script still runs far enough to report its own usage', () => {
    // An unbound-variable death happens before argument parsing, so a usage/So-far message is
    // proof the top of the script executed.
    const r = bash('bash orchestrations/scripts/brownfield-repro-test-writer.sh 2>&1 | head -3');
    expect(r.stdout).not.toMatch(/unbound variable/);
  });
});
