// THE ADVISORY PATH MATCHED A STRING NOTHING REQUIRED THE MODEL TO PRODUCE.
//
// 665f1a5 made a brownfield CVE advisory when the story did not introduce the package. It decides
// which findings are dependency CVEs with `re.compile(r'^dependency-cve-')`, and that prefix was
// read off ONE live run's output. The SAST prompt's contract for that field is literally:
//
//     "findings": [{ "severity": "...", "rule": "...", ... }]
//
// Free-form. Nothing in the prompt, the schema or the engine tells the sentinel what to call a
// dependency CVE. It happened to emit dependency-cve-critical-runtime, dependency-cve-dev-only and
// dependency-cve-high-runtime, so the gate worked — on that draw, with that model.
//
// A different model, or the same one on a different draw, emitting `cve-dependency-critical` makes
// every dependency finding invisible to the advisory path, and the gate silently reverts to
// hard-stopping on pre-existing repository debt: the exact failure 665f1a5 exists to prevent, with
// no signal that it has happened. A green run and a broken run look identical.
//
// The prompt is the contract. The rule vocabulary is DECLARED once, the prompt is told to use it,
// and the gate reads the same declaration — so the two cannot drift.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const VOCAB = join(ROOT, 'orchestrations/config/sast-vocabulary.json');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/qa-sast-sentinel.json');
const BLOCKERS = join(ROOT, 'orchestrations/scripts/lib/handlers/sast-blockers.py');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const templateBody = () => {
  const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  return String(doc.body ?? Object.values(doc.bodies ?? {})[0] ?? '');
};

describe('the vocabulary is declared once', () => {
  it('there is a single declaration of the dependency-CVE rule name', () => {
    const v = JSON.parse(readFileSync(VOCAB, 'utf8'));
    expect(typeof v.dependencyCveRulePrefix, 'no single place declares it').toBe('string');
    expect(v.dependencyCveRulePrefix.length).toBeGreaterThan(3);
  });

  it('the gate does not carry its own copy of the string', () => {
    const py = readFileSync(BLOCKERS, 'utf8');
    const executable = py.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const prefix = JSON.parse(readFileSync(VOCAB, 'utf8')).dependencyCveRulePrefix;
    expect(executable, `sast-blockers.py hardcodes "${prefix}" instead of reading the declaration`)
      .not.toContain(prefix);
  });
});

describe('the prompt asks for what the gate matches', () => {
  it('the template tells the sentinel how to name a dependency-CVE finding', () => {
    const body = templateBody();
    expect(body, 'the rule field is still free-form — the gate is matching a guess')
      .toMatch(/__DEPENDENCY_CVE_RULE_PREFIX__/);
  });

  it('and declares the placeholder it uses', () => {
    const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    expect(doc.placeholders).toContain('__DEPENDENCY_CVE_RULE_PREFIX__');
  });

  it('the producer supplies it', () => {
    const sh = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(sh).toMatch(/__DEPENDENCY_CVE_RULE_PREFIX__/);
  });
});

// The point of a single declaration is that changing it moves BOTH sides. If only one moves, the
// declaration is decoration and the drift it was meant to prevent is still possible.
describe('one declaration drives both sides', () => {
  const report = (rule: string) => JSON.stringify({
    summary: { blockerCount: 1 },
    findings: [{ severity: 'blocker', rule, file: 'package.json',
                 description: '[critical] (runtime) legacy-pkg: something old' }],
  });

  const countBlockers = (json: string, vocabOverride?: string) => {
    const d = mkdtempSync(join(tmpdir(), 'sast-vocab-')); made.push(d);
    const log = join(d, 'sast.log');
    writeFileSync(log, json);
    const env: NodeJS.ProcessEnv = { ...process.env, EPAM_BROWNFIELD: '1', EPAM_STORY_INTRODUCED_DEPS: '' };
    if (vocabOverride) env.EPAM_SAST_VOCABULARY = vocabOverride;
    const r = spawnSync('python3', [BLOCKERS, log], { encoding: 'utf8', env });
    return (r.stdout || '').trim();
  };

  it('a finding named by the declared vocabulary is advisory (pre-existing debt)', () => {
    const prefix = JSON.parse(readFileSync(VOCAB, 'utf8')).dependencyCveRulePrefix;
    expect(countBlockers(report(`${prefix}critical-runtime`))).toBe('0');
  });

  it('a finding named some other way still blocks — it is not a dependency CVE', () => {
    expect(countBlockers(report('hardcoded-credential'))).toBe('1');
  });

  it('moving the declaration moves what the GATE recognises', () => {
    const d = mkdtempSync(join(tmpdir(), 'vocab-alt-')); made.push(d);
    const alt = join(d, 'sast-vocabulary.json');
    writeFileSync(alt, JSON.stringify({ dependencyCveRulePrefix: 'cve-dep-' }));
    // Under the alternative vocabulary the OLD name is no longer a dependency CVE...
    expect(countBlockers(report('dependency-cve-critical-runtime'), alt)).toBe('1');
    // ...and the NEW one is.
    expect(countBlockers(report('cve-dep-critical-runtime'), alt)).toBe('0');
  });

  it('moving the declaration moves what the PROMPT asks for', () => {
    // The template holds a placeholder, so the rendered prompt carries whatever the declaration
    // says. If the body ever hardcodes the value, this catches it.
    const prefix = JSON.parse(readFileSync(VOCAB, 'utf8')).dependencyCveRulePrefix;
    expect(templateBody(), 'the template hardcodes the rule name instead of taking the value')
      .not.toContain(prefix);
  });
});

describe('when the declaration is missing', () => {
  // Falling back to a built-in default would reinstate the guess this removed, and would do it
  // invisibly. Without a declaration nothing can be classified as pre-existing debt, so every
  // finding blocks — the safe direction — and the reason is said out loud.
  it('nothing is treated as pre-existing debt, and it says why', () => {
    const d = mkdtempSync(join(tmpdir(), 'vocab-empty-')); made.push(d);
    const empty = join(d, 'sast-vocabulary.json');
    writeFileSync(empty, JSON.stringify({}));
    const log = join(d, 'sast.log');
    writeFileSync(log, JSON.stringify({
      summary: { blockerCount: 1 },
      findings: [{ severity: 'blocker', rule: 'dependency-cve-critical-runtime',
                   file: 'package.json', description: '[critical] (runtime) legacy-pkg' }],
    }));
    const r = spawnSync('python3', [BLOCKERS, log], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_BROWNFIELD: '1', EPAM_STORY_INTRODUCED_DEPS: '', EPAM_SAST_VOCABULARY: empty },
    });
    expect(r.stdout.trim(), 'a missing declaration silently let a finding through').toBe('1');
    expect(r.stderr, 'it failed safe but said nothing').toMatch(/dependencyCveRulePrefix|pre-existing/i);
  });
});
