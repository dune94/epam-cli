import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EscalateDefectTool } from '../../../src/tools/builtin/EscalateDefect.js';

// The words come from the project-owned catalogue (EPAM_AGENT_MESSAGE_CATALOG), as they do at run
// time; without it the engine emits the structured code form and says no sentence of its own.
process.env.EPAM_AGENT_MESSAGE_CATALOG = join(__dirname, '../../../orchestrations/config/agent-messages.json');

describe('EscalateDefectTool', () => {
  let projectRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'escalate-defect-test-'));
    savedEnv.EPAM_STORY_ID = process.env.EPAM_STORY_ID;
    savedEnv.PROJECT_ROOT = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = projectRoot;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (savedEnv.EPAM_STORY_ID === undefined) delete process.env.EPAM_STORY_ID;
    else process.env.EPAM_STORY_ID = savedEnv.EPAM_STORY_ID;
    if (savedEnv.PROJECT_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = savedEnv.PROJECT_ROOT;
  });

  it('has the expected tool contract (name, permission, schema)', () => {
    const tool = new EscalateDefectTool();
    expect(tool.name).toBe('escalate_defect_to_sibling_story');
    expect(tool.permission).toBe('review');
    expect(tool.definition.inputSchema.required).toEqual(['targetFile', 'diagnosis', 'requiredFix']);
  });

  it('fails clearly when EPAM_STORY_ID is not set (tool is orchestration-only)', async () => {
    delete process.env.EPAM_STORY_ID;
    const tool = new EscalateDefectTool();
    const result = await tool.execute({
      targetFile: 'src/client.ts',
      diagnosis: 'constructor missing validation',
      requiredFix: 'throw on missing apiKey',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/EPAM_STORY_ID is not set/);
  });

  it('REPRODUCES the exact live scenario: SKY-002-test escalates a defect in client.ts (owned by SKY-002-impl)', async () => {
    process.env.EPAM_STORY_ID = 'SKY-002-test';
    const tool = new EscalateDefectTool();
    const result = await tool.execute({
      targetFile: 'src/skyscanner/client.ts',
      diagnosis: 'Constructor lacks validation that apiKey is provided; must throw on undefined/empty apiKey.',
      requiredFix: 'Add a guard in the constructor that throws when apiKey is undefined or empty.',
    });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/Escalation filed/);
    expect(result.content).toMatch(/Do not attempt to modify this file/);

    const escalationPath = join(projectRoot, '.epam', 'escalations', 'SKY-002-test.json');
    expect(existsSync(escalationPath)).toBe(true);
    const record = JSON.parse(readFileSync(escalationPath, 'utf-8'));
    expect(record.fromStoryId).toBe('SKY-002-test');
    expect(record.targetFile).toBe('src/skyscanner/client.ts');
    expect(record.diagnosis).toMatch(/Constructor lacks validation/);
    expect(record.requiredFix).toMatch(/throws when apiKey/);
    expect(record.createdAt).toBeTruthy();
  });

  it('creates the .epam/escalations directory if it does not exist yet', async () => {
    process.env.EPAM_STORY_ID = 'SKY-003-test';
    const tool = new EscalateDefectTool();
    expect(existsSync(join(projectRoot, '.epam'))).toBe(false);
    await tool.execute({ targetFile: 'src/cli.ts', diagnosis: 'd', requiredFix: 'f' });
    expect(existsSync(join(projectRoot, '.epam', 'escalations'))).toBe(true);
  });

  it('a second escalation from the same story overwrites the first (one pending escalation per story)', async () => {
    process.env.EPAM_STORY_ID = 'SKY-002-test';
    const tool = new EscalateDefectTool();
    await tool.execute({ targetFile: 'src/a.ts', diagnosis: 'first', requiredFix: 'fix1' });
    await tool.execute({ targetFile: 'src/b.ts', diagnosis: 'second', requiredFix: 'fix2' });
    const escalationPath = join(projectRoot, '.epam', 'escalations', 'SKY-002-test.json');
    const record = JSON.parse(readFileSync(escalationPath, 'utf-8'));
    expect(record.targetFile).toBe('src/b.ts');
    expect(record.diagnosis).toBe('second');
  });

  it('is generic — works for any story id / file / diagnosis, no travel-app-specific assumptions', async () => {
    process.env.EPAM_STORY_ID = 'CHECKOUT-004-test';
    const tool = new EscalateDefectTool();
    const result = await tool.execute({
      targetFile: 'src/payments/gateway.ts',
      diagnosis: 'Refund handler does not validate currency code',
      requiredFix: 'Add ISO 4217 currency validation before calling the refund API',
    });
    expect(result.isError).toBe(false);
    const record = JSON.parse(
      readFileSync(join(projectRoot, '.epam', 'escalations', 'CHECKOUT-004-test.json'), 'utf-8')
    );
    expect(record.targetFile).toBe('src/payments/gateway.ts');
  });
});

/**
 * AN ESCALATION FOR A FILE THE STORY ITSELF OWNS IS REFUSED, AND SAYS SO.
 *
 * regintel 20260919T224649Z resume 7 (2026-09-20 08:04): REGI-007a, which declares
 * regintel/pipeline.py, filed an escalation FOR regintel/pipeline.py and was told "Do not attempt
 * to modify this file — it is outside your scope." It obeyed, the resolver found no OTHER owner,
 * and the story burned its ladder on a fix it was allowed to make all along. The tool knows the
 * scope the writer runs with (EPAM_ALLOWED_WRITE_PATHS — WriteFile's scope guard reads the same
 * variable); it answered without looking.
 */
describe('an escalation for a file the story itself owns', () => {
  const savedScope = process.env.EPAM_ALLOWED_WRITE_PATHS;
  const savedRoot = process.env.PROJECT_ROOT;
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'escalate-own-')); process.env.PROJECT_ROOT = root; });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedScope === undefined) delete process.env.EPAM_ALLOWED_WRITE_PATHS;
    else process.env.EPAM_ALLOWED_WRITE_PATHS = savedScope;
    if (savedRoot === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = savedRoot;
  });

  async function escalate(target: string, scope: string[]) {
    process.env.EPAM_STORY_ID = 'REGI-007a';
    process.env.EPAM_ALLOWED_WRITE_PATHS = scope.map((s) => join(process.env.PROJECT_ROOT as string, s)).join(':');
    const tool = new EscalateDefectTool();
    return tool.execute({ targetFile: target, diagnosis: 'imports a name that does not exist', requiredFix: 'import the right name' });
  }

  it('is refused: the fix is the caller\'s own, and no escalation file is written', async () => {
    const r = await escalate('regintel/pipeline.py', ['regintel/api.py', 'regintel/pipeline.py', 'scripts/serve.py']);
    expect(r.isError, r.content).toBe(true);
    expect(r.content).toMatch(/regintel\/pipeline\.py/);
    expect(r.content).not.toMatch(/outside your scope/);
    expect(existsSync(join(process.env.PROJECT_ROOT as string, '.epam', 'escalations', 'REGI-007a.json'))).toBe(false);
  });

  it('the absolute spelling of an owned file is refused the same way', async () => {
    const abs = join(process.env.PROJECT_ROOT as string, 'regintel/pipeline.py');
    const r = await escalate(abs, ['regintel/pipeline.py']);
    expect(r.isError).toBe(true);
    expect(existsSync(join(process.env.PROJECT_ROOT as string, '.epam', 'escalations', 'REGI-007a.json'))).toBe(false);
  });

  it('a file under an owned directory is the caller\'s too', async () => {
    const r = await escalate('dial/client.py', ['dial/']);
    expect(r.isError).toBe(true);
  });

  it('a file outside the scope is still escalated', async () => {
    const r = await escalate('regintel/classifier.py', ['regintel/api.py', 'regintel/pipeline.py']);
    expect(r.isError).toBe(false);
    expect(existsSync(join(process.env.PROJECT_ROOT as string, '.epam', 'escalations', 'REGI-007a.json'))).toBe(true);
  });

  it('with no scope declared (a caller that never computed it) the escalation is filed as before', async () => {
    process.env.EPAM_STORY_ID = 'REGI-007a';
    delete process.env.EPAM_ALLOWED_WRITE_PATHS;
    const tool = new EscalateDefectTool();
    const r = await tool.execute({ targetFile: 'regintel/pipeline.py', diagnosis: 'd', requiredFix: 'f' });
    expect(r.isError).toBe(false);
  });

  it('the words come from the agent-message catalogue, not the tool', async () => {
    const r = await escalate('regintel/pipeline.py', ['regintel/pipeline.py']);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const catalogue = JSON.parse(readFileSync(join(__dirname, '../../../orchestrations/config/agent-messages.json'), 'utf8'));
    expect(catalogue.escalation_refused_own_file, 'no catalogue entry').toBeTruthy();
    expect(catalogue.escalation_filed, 'no catalogue entry for the filed message').toBeTruthy();
    expect(r.content).toBe(String(catalogue.escalation_refused_own_file).replace(/\{(\w+)\}/g, (w: string, k: string) => ({ path: 'regintel/pipeline.py', declared: join(process.env.PROJECT_ROOT as string, 'regintel/pipeline.py') } as any)[k] ?? w));
  });
});
