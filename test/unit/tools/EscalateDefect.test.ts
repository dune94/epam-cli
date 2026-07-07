import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EscalateDefectTool } from '../../../src/tools/builtin/EscalateDefect.js';

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
