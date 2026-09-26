/**
 * A CONSUMED FILE NAMES A STORY THAT HOLDS IT.
 *
 * The spec pass lets an agent say "this story consumes file X from story Y": X leaves the story's
 * scope and Y becomes a dependency. Nothing checked Y. Live, regintel run 20260926T125158Z:
 *
 *   REGI-006 consumes tests/test_injection.py from REGI-005 — REGI-005 had been SPLIT into 005a/005b
 *     and neither declares the file. REGI-006 was left with no files, the writer's prompt had nothing
 *     to render ("EMPTY values for: __FILES__"), the story failed and the core phase aborted.
 *   REGI-014 consumes dial/client.py from REGI-014a — a story that does not exist, for a file REGI-014
 *     itself owns (ownsSharedFiles). REGI-014 waited on it and never ran.
 *
 * The rule, executed through the path a resume takes (prd-remediate.sh before the phase), on that
 * run's own PRD: a claim stands only when its owner — followed through a split to the child that
 * declares the file — is a story in the PRD, is not the claimant, and declares the file. A story
 * cannot consume what it owns. A rejected claim gives the file back (when the spec pass took it or
 * the authored story declared it) and drops a dependency on a story that is not in the PRD.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const REMEDIATE = join(ROOT, 'orchestrations/scripts/prd-remediate.sh');
const RUN_PRD = join(ROOT, 'test/fixtures/regintel/prd-20260926T125158Z.json');
const CANONICAL = join(ROOT, 'test/fixtures/regintel/prd-20260926.canonical.json');

type Story = { id: string; status?: string; dependencies?: string[]; ownsSharedFiles?: string[];
  technicalNotes?: { files?: string[] }; consumesInterfaces?: { file: string; ownerStoryId?: string }[];
  consumesInterfacesRejected?: { file: string; ownerStoryId?: string; reason: string }[];
  specification?: { createdFrom?: string } };
type Prd = { stories: Story[] };

let dir = '';
const load = (p: string): Prd => JSON.parse(readFileSync(p, 'utf8'));
const byId = (prd: Prd, id: string) => prd.stories.find((s) => s.id === id)!;

/** Run the pipeline's own pre-phase remediation on a copy of `prd`, as a resume does. */
function remediate(prd: Prd, name: string) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(prd, null, 2));
  // Exactly as that run's resume invokes it: the run it resumes, the provider set it ran on, and a
  // log directory of its own (the resume clears a re-queued story's ladder files there).
  const r = spawnSync('bash', [REMEDIATE, '--prd', file, '--phase', 'core'], {
    encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PRD_CANONICAL: CANONICAL, EPAM_BROWNFIELD: '0', EPAM_RESUME_RUN: '20260926T125158Z',
      EPAM_PROVIDER_SET: 'openrouter', LOG_DIR: join(dir, 'logs') },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, prd: load(file) };
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'consumed-file-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the run that stopped: REGI-006 and REGI-014 on run 20260926T125158Z\'s own PRD', () => {
  let before: Prd; let after: Prd; let out = '';
  beforeAll(() => {
    before = load(RUN_PRD);
    // Guard against a vacuous pass: the fixture must hold the two broken claims.
    expect(byId(before, 'REGI-006').technicalNotes?.files).toEqual([]);
    expect(byId(before, 'REGI-014').dependencies).toContain('REGI-014a');
    const r = remediate(before, 'run');
    expect(r.status, r.out).toBe(0);
    after = r.prd; out = r.out;
  });

  it('REGI-006 gets its file back: the owner it named was split, and no child declares the file', () => {
    const s = byId(after, 'REGI-006');
    expect(s.technicalNotes?.files).toEqual(['tests/test_injection.py']);
    expect((s.consumesInterfaces || []).map((c) => c.file)).not.toContain('tests/test_injection.py');
    expect(s.consumesInterfacesRejected?.find((c) => c.file === 'tests/test_injection.py')?.reason).toMatch(/REGI-005/);
  });

  it('REGI-014 no longer waits on a story that does not exist, and keeps the file it owns', () => {
    const s = byId(after, 'REGI-014');
    expect(s.dependencies).not.toContain('REGI-014a');
    expect(s.dependencies).toEqual(expect.arrayContaining(['REGI-004', 'REGI-010']));
    expect(s.technicalNotes?.files).toContain('dial/client.py');
    expect(s.consumesInterfacesRejected?.find((c) => c.file === 'dial/client.py')?.reason).toMatch(/owns/);
  });

  it('says what it changed', () => {
    expect(out).toMatch(/REGI-006.*tests\/test_injection\.py/);
    expect(out).toMatch(/REGI-014.*dial\/client\.py/);
  });

  it('changes nothing else: every other story\'s files, dependencies and claims are as they were', () => {
    const pick = (p: Prd) => p.stories.filter((s) => !['REGI-006', 'REGI-014'].includes(s.id))
      .map((s) => ({ id: s.id, files: s.technicalNotes?.files, deps: s.dependencies, consumes: s.consumesInterfaces }));
    // prd-remediate's other steps must not be what moves these either: compared with the same
    // script's output on the same PRD, the claims aside, every story is untouched.
    expect(pick(after)).toEqual(pick(before));
  });
});

describe('the rule, case by case, on the same real PRD', () => {
  it('a claim on a split owner follows the split to the child that declares the file', () => {
    const prd = load(RUN_PRD);
    byId(prd, 'REGI-005b').technicalNotes!.files!.push('tests/test_injection.py');
    const { status, out, prd: after } = remediate(prd, 'split-child-declares');
    expect(status, out).toBe(0);
    const s = byId(after, 'REGI-006');
    expect(s.consumesInterfaces).toEqual([expect.objectContaining({ file: 'tests/test_injection.py', ownerStoryId: 'REGI-005b' })]);
    expect(s.dependencies).toContain('REGI-005b');
    expect(s.technicalNotes?.files).toEqual([]);   // consumed for real: the child writes it
  });

  it('a claim on an owner that declares the file stands, untouched', () => {
    const prd = load(RUN_PRD);
    const s = byId(prd, 'REGI-006');
    s.consumesInterfaces = [{ file: 'tests/test_escalation.py', ownerStoryId: 'REGI-005b' }];
    const { status, out, prd: after } = remediate(prd, 'valid-claim');
    expect(status, out).toBe(0);
    expect(byId(after, 'REGI-006').consumesInterfaces).toEqual([{ file: 'tests/test_escalation.py', ownerStoryId: 'REGI-005b' }]);
    expect(byId(after, 'REGI-006').consumesInterfacesRejected).toBeUndefined();
  });

  it('a rejected claim never adds a file the story was not given — neither by the spec pass nor the authored PRD', () => {
    const prd = load(RUN_PRD);
    const s = byId(prd, 'REGI-006');
    s.consumesInterfaces = [{ file: 'regintel/api.py', ownerStoryId: 'REGI-999' }];
    const { status, out, prd: after } = remediate(prd, 'foreign-file');
    expect(status, out).toBe(0);
    expect(byId(after, 'REGI-006').technicalNotes?.files).not.toContain('regintel/api.py');
    expect(byId(after, 'REGI-006').consumesInterfacesRejected?.[0]?.file).toBe('regintel/api.py');
  });

  it('completed and deprecated stories are history: their claims are not rewritten', () => {
    const before = load(RUN_PRD);
    const { status, out, prd: after } = remediate(before, 'history');
    expect(status, out).toBe(0);
    for (const id of ['REGI-004', 'REGI-005', 'REGI-010']) {
      expect(byId(after, id).consumesInterfaces).toEqual(byId(before, id).consumesInterfaces);
      expect(byId(after, id).consumesInterfacesRejected).toBeUndefined();
    }
  });
});

describe('the spec pass applies the same rule before it writes the PRD', () => {
  it('spec-mode-runner.js reconciles through the one shared module, and records the files a claim removed', () => {
    const { reconcileConsumedInterfaces } = require(join(ROOT, 'orchestrations/scripts/lib/consumed-interfaces.js'));
    const { applySpecChanges } = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
    const prd = load(CANONICAL) as Prd & Record<string, unknown>;
    // The spec agent's real REGI-006 claim, applied the way the spec pass applies it, after REGI-005
    // has been split into children that do not declare the file.
    const r5 = byId(prd, 'REGI-005');
    r5.status = 'deprecated';
    prd.stories.push({ id: 'REGI-005a', status: 'pending', technicalNotes: { files: ['regintel/escalation.py'] }, specification: { createdFrom: 'REGI-005' } },
      { id: 'REGI-005b', status: 'pending', technicalNotes: { files: ['tests/test_escalation.py'] }, specification: { createdFrom: 'REGI-005' } });
    const s6 = byId(prd, 'REGI-006');
    applySpecChanges(s6, { consumesInterfaces: [{ file: 'tests/test_injection.py', symbol: null, ownerStoryId: 'REGI-005' }] }, [], prd, 'core', 'test-run');
    expect(s6.technicalNotes?.files).toEqual([]);              // the claim took it …
    const changes = reconcileConsumedInterfaces(prd, {});
    expect(s6.technicalNotes?.files).toEqual(['tests/test_injection.py']);   // … and the rule gave it back
    expect(changes.length).toBe(1);
  });
});
