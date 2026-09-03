/**
 * THE QA SENTINEL PROMPTS ARE TEMPLATES.
 *
 * 11-16 of the twenty seams: the six QA gates that run after the writer — sast, spec
 * validation, review ranging, mutant hunting, fuzz weaving and perf. Each is a separate gate
 * with its own verdict, and each carried its instructions as a shell string.
 *
 * SIX TEMPLATES, NOT ONE PARAMETERISED TEMPLATE. They instruct differently and take different
 * inputs — only three take the browser-routing facts, only one takes the mutant oracle. A
 * single prompt with six branches would hide which instructions a given gate received, which
 * is the thing this migration exists to make visible.
 *
 * All six embed a shared scope block through a COMMAND SUBSTITUTION rather than a plain
 * variable, so the capture had to stub that function; it arrives as a value like any other.
 *
 * The test EXECUTES the rewired blocks out of the shipped script and compares them to a
 * capture taken before the move.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GOLDEN = join(ROOT, 'test/fixtures/prompt-migration/qa-sentinels.golden.json');
const VERIFY = join(ROOT, 'test/fixtures/prompt-migration/verify-qa-sentinels.sh');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const T = (id: string) => join(ROOT, 'orchestrations/prompts/templates', `${id}.json`);
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

const NAMES = ['sast-sentinel', 'spec-validator', 'review-ranger', 'mutant-hunter', 'fuzz-weaver', 'perf-sentinel'];
const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8'));

function rendered(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'qa-sentinels-'));
  try {
    const res = spawnSync('bash', [VERIFY, SCRIPTS, dir], {
      encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath },
    });
    const out: Record<string, string> = {};
    for (const n of NAMES) {
      const p = join(dir, `${n}.now`);
      out[n] = existsSync(p) ? readFileSync(p, 'utf8') : `__NOT_PRODUCED__ ${res.stderr}`;
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the golden capture is real', () => {
  it('matches every digest and all six differ from each other', () => {
    const g = golden();
    for (const n of NAMES) {
      expect(createHash('sha256').update(g.output[n]).digest('hex'), n).toBe(g.sha256[n]);
    }
    expect(new Set(NAMES.map((n) => g.output[n])).size, 'two sentinels share a prompt').toBe(6);
  });
});

describe('all six live in the template layer', () => {
  it('every template exists and every seam declares it', () => {
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    for (const n of NAMES) {
      expect(existsSync(T(`qa-${n}`)), `qa-${n} missing`).toBe(true);
      expect(r.profiles[`qa-gate:${n.replace('-sentinel', '').replace('sast', 'sast')}`]?.template
        || r.profiles[`qa-gate:${n}`]?.template, `${n} seam not linked`).toBeTruthy();
    }
  });

  it('each declares exactly the placeholders its body uses', () => {
    for (const n of NAMES) {
      const doc = JSON.parse(readFileSync(T(`qa-${n}`), 'utf8'));
      const used = [...new Set(String(doc.body).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();
      expect([...doc.placeholders].sort(), n).toEqual(used);
    }
  });

  it('they take DIFFERENT inputs — which is why they are six templates', () => {
    const ph = (n: string) => JSON.parse(readFileSync(T(`qa-${n}`), 'utf8')).placeholders as string[];
    expect(ph('mutant-hunter')).toContain('__MUTANT_ORACLE_SUMMARY__');
    expect(ph('sast-sentinel')).not.toContain('__MUTANT_ORACLE_SUMMARY__');
    expect(ph('review-ranger')).toContain('__REVIEW_DIFF_SUMMARY__');
    expect(ph('sast-sentinel')).not.toContain('__ROUTING_DECISION__');
  });

  it('none names a project or a fixture value', () => {
    for (const n of NAMES) {
      const body = JSON.parse(readFileSync(T(`qa-${n}`), 'utf8')).body as string;
      for (const lit of ['PROJECTROOT_S', 'GATESCOPE_S', 'metrolinx', 'gotransit']) {
        expect(body, `qa-${n} contains '${lit}'`).not.toContain(lit);
      }
    }
  });
});

describe('the migration changed no bytes', () => {
  it('the shipped shell reproduces all six exactly', () => {
    const g = golden();
    const now = rendered();
    for (const n of NAMES) {
      expect(now[n], `${n} did not render`).not.toMatch(/__NOT_PRODUCED__/);
      expect(now[n], `${n} differs`).toBe(g.output[n]);
    }
  });
});
