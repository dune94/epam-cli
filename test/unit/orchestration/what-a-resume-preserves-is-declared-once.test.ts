/**
 * WHAT A RESUME PRESERVES IS DECLARED ONCE.
 *
 * Between 2026-09-15 and 2026-09-20 five components each had to be taught "this is a resume"
 * separately, one live failure at a time: the launcher tore the codeline down (09-15), the
 * lifecycle passed --reset (09-16), pre-run-reset archived the run's ledgers (09-18), pre-flight
 * refused the run's own spec blocks (09-15) and healing ledger (09-19), and the remediation reset
 * 14 completed stories ($20, 09-20). Each read EPAM_RESUME_RUN on its own and decided on its
 * own what that meant.
 *
 * One declaration (config/resume-preserves.json) says what a resume keeps; one reader
 * (lib/resume-semantics.sh, and its Python twin) answers `resume_preserves <aspect>`; every
 * consumer asks it. An aspect nobody declared is a loud refusal, not a guess.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CFG = join(ROOT, 'orchestrations/config/resume-preserves.json');
const LIB = join(ROOT, 'orchestrations/scripts/lib/resume-semantics.sh');
const PY = join(ROOT, 'orchestrations/scripts/lib/handlers/resume_semantics.py');

function ask(aspect: string, env: Record<string, string>) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; resume_preserves ${JSON.stringify(aspect)} && echo YES || echo "NO:$?"`], { encoding: 'utf8', env: { ...process.env, ...env } });
  return `${r.stdout}${r.stderr}`;
}

describe('the declaration', () => {
  const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
  it('names every aspect the incidents taught, each with its reason', () => {
    for (const a of ['prd-state', 'codeline', 'ledgers', 'roster', 'prompts', 'fetched-documents', 'phase-gates', 'completed-stories', 'spec-blocks', 'checkpoint']) {
      expect(cfg.preserves[a], `aspect '${a}' is not declared`).toBeTruthy();
      expect(String(cfg.preserves[a]).length, `aspect '${a}' has no reason`).toBeGreaterThan(20);
    }
  });
});

describe('the reader (bash)', () => {
  it('a declared aspect is preserved on a resume', () => { expect(ask('completed-stories', { EPAM_RESUME_RUN: 'R1' })).toContain('YES'); });
  it('nothing is "preserved" on a fresh launch', () => { expect(ask('completed-stories', { EPAM_RESUME_RUN: '' })).toMatch(/^NO:1/); });
  it('an undeclared aspect is refused loudly, resume or not', () => {
    const out = ask('unicorns', { EPAM_RESUME_RUN: 'R1' });
    expect(out).toMatch(/NO:2/);
    expect(out).toMatch(/not declared/i);
  });
  it('is_resume answers the plain question', () => {
    expect(spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; is_resume && echo Y || echo N`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: 'R1' } }).stdout).toContain('Y');
    expect(spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; is_resume && echo Y || echo N`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: '' } }).stdout).toContain('N');
  });
});

describe('the reader (python, for the remediation)', () => {
  it('answers the same way from the same file', () => {
    const y = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/handlers'))}); from resume_semantics import resume_preserves; print(resume_preserves('completed-stories'))`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: 'R1' } });
    expect(y.stdout.trim(), y.stderr).toBe('True');
    const n = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/handlers'))}); from resume_semantics import resume_preserves; print(resume_preserves('completed-stories'))`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: '' } });
    expect(n.stdout.trim()).toBe('False');
    const u = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/handlers'))}); from resume_semantics import resume_preserves; print(resume_preserves('unicorns'))`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: 'R1' } });
    expect(u.status).not.toBe(0);
  });
});

describe('every consumer asks the reader', () => {
  const consumers: Array<[string, string[]]> = [
    ['orchestrations/scripts/tier3-run.sh', ['prd-state', 'codeline']],
    ['orchestrations/scripts/lib/greenfield-lifecycle.sh', ['completed-stories', 'phase-gates']],
    ['orchestrations/scripts/pre-run-reset.sh', ['ledgers', 'roster', 'fetched-documents']],
    ['orchestrations/scripts/prd-remediate.sh', ['spec-blocks']],
    ['orchestrations/scripts/_prd_remediate_impl.py', ['completed-stories']],
    ['orchestrations/scripts/preflight-check.sh', ['spec-blocks', 'prd-state', 'ledgers']],
  ];
  for (const [file, aspects] of consumers) {
    it(`${file} decides through resume_preserves(${aspects.join(', ')}) and never tests EPAM_RESUME_RUN itself`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      for (const a of aspects) expect(src, `${file} does not ask about '${a}'`).toMatch(new RegExp(`resume_preserves\\(?\\s*['"]?${a}`));
      const own = src.split('\n').filter((l) => /-n\s+"?\$\{?EPAM_RESUME_RUN|EPAM_RESUME_RUN:-\}"?\s*\]|os\.environ\.get\('EPAM_RESUME_RUN'\)/.test(l) && !/^\s*#/.test(l));
      expect(own, `${file} still decides on EPAM_RESUME_RUN directly:\n${own.join('\n')}`).toEqual([]);
    });
  }
});
