/**
 * A RESUME ADOPTS THE STORIES AUTHORED SINCE IT BEGAN — and they get through pre-phase remediation.
 *
 * regintel run 20260926T125158Z: the live DIAL check of the run's own output found two defects, and
 * REGI-015/016 were authored for them. A resumed run keeps its own PRD and never read the authored one,
 * so the stories could reach it only by rebuilding everything. And once adopted, the integrity audit
 * (check #11) demanded an aiProvider of every active story — a field the model coordinator assigns at
 * Step 7, after remediation — so the resume would have aborted before the phase began.
 *
 * Executed as that resume executes it: the lifecycle function tier3-run.sh calls, on the run's own PRD
 * and the authored PRD, then prd-remediate.sh with the run id, provider set and a log dir of its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIFECYCLE = join(ROOT, 'orchestrations/scripts/lib/greenfield-lifecycle.sh');
const REMEDIATE = join(ROOT, 'orchestrations/scripts/prd-remediate.sh');
const RUN_PRD = join(ROOT, 'test/fixtures/regintel/prd-20260926T125158Z.json');
const CANONICAL = join(ROOT, 'test/fixtures/regintel/prd-20260927.canonical.json');

type Story = { id: string; status?: string; aiProvider?: string; specification?: object };
type Prd = { stories: Story[]; implementationOrder: Record<string, string[]> };
const load = (p: string): Prd => JSON.parse(readFileSync(p, 'utf8'));
let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'adopt-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function adopt(prdFile: string) {
  const script = `info(){ echo "$*"; }; fail(){ echo "FAIL: $*"; exit 1; }; . ${JSON.stringify(LIFECYCLE)}; greenfield_adopt_authored_stories ${JSON.stringify(CANONICAL)} ${JSON.stringify(prdFile)} ${JSON.stringify(ROOT)}`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: ROOT });
}
function remediate(prdFile: string) {
  return spawnSync('bash', [REMEDIATE, '--prd', prdFile, '--phase', 'core'], {
    encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PRD_CANONICAL: CANONICAL, EPAM_BROWNFIELD: '0', EPAM_RESUME_RUN: '20260926T125158Z',
      EPAM_PROVIDER_SET: 'openrouter', LOG_DIR: join(dir, 'logs') },
  });
}

describe('the resume adopts REGI-015/016 into run 20260926T125158Z\'s own PRD', () => {
  let file = ''; let before: Prd; let after: Prd; let out = '';
  beforeAll(() => {
    file = join(dir, 'run.json'); copyFileSync(RUN_PRD, file);
    before = load(file);
    const r = adopt(file); out = r.stdout + r.stderr;
    expect(r.status, out).toBe(0);
    after = load(file);
  });

  it('appends the two authored stories to core, after the phase\'s own stories, as pending', () => {
    expect(after.implementationOrder.core).toEqual([...before.implementationOrder.core, 'REGI-015', 'REGI-016']);
    for (const id of ['REGI-015', 'REGI-016']) {
      const s = after.stories.find((x) => x.id === id)!;
      expect(s.status).toBe('pending');
      expect(s.specification).toBeUndefined();
    }
    expect(out).toMatch(/adopted authored story REGI-015 into phase 'core'/);
  });

  it('changes nothing the run holds: every existing story and every other phase is as it was', () => {
    expect(after.stories.slice(0, before.stories.length)).toEqual(before.stories);
    expect(after.implementationOrder.scaffold).toEqual(before.implementationOrder.scaffold);
    expect(after.stories.length).toBe(before.stories.length + 2);
  });

  it('a second resume adopts nothing — the split parents and the adopted stories are all present', () => {
    const r = adopt(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/adopted/);
    expect(load(file)).toEqual(after);
  });

  it('pre-phase remediation passes with the adopted stories still in core', () => {
    const r = remediate(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(load(file).implementationOrder.core).toEqual(expect.arrayContaining(['REGI-015', 'REGI-016']));
  });
});

describe('the integrity audit still holds an elaborated story to its fields', () => {
  it('a story the spec pass has elaborated, with no aiProvider, still fails remediation', () => {
    const file = join(dir, 'elaborated.json'); copyFileSync(RUN_PRD, file);
    const prd = load(file);
    const s = prd.stories.find((x) => x.id === 'REGI-006')!;
    expect(s.specification).toBeDefined();
    delete s.aiProvider;
    writeFileSync(file, JSON.stringify(prd, null, 2));
    const r = remediate(file);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/REGI-006: missing aiProvider/);
  });
});
