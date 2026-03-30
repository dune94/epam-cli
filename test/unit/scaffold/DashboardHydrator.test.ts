import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { MANAGED_DASHBOARD_FILES, hydrateDashboards } from '../../../src/scaffold/DashboardHydrator.js';

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'epam-dash-'));
  tempDirs.push(dir);
  return dir;
}

async function setupProject(projectRoot: string): Promise<void> {
  const orch = join(projectRoot, 'orchestrations');
  const dashboards = join(orch, 'dashboards');
  await mkdir(join(orch, 'agents'), { recursive: true });
  await mkdir(dashboards, { recursive: true });
  await writeFile(join(orch, 'prd.json'), JSON.stringify({
    id: 'TEST-PRD',
    title: 'Test Project',
    project: { name: 'demo' },
    implementationOrder: { foundation: ['TEST-001'] },
  }), 'utf-8');
  await writeFile(join(orch, 'agents', 'profiles.json'), JSON.stringify({
    'spec-coordinator-agent': 'x',
    'pipeline-engineer': 'x',
  }), 'utf-8');
  await writeFile(join(dashboards, '.eleventy.js'), 'module.exports = () => ({ dir: { input: ".", output: "live" } });', 'utf-8');
}

function htmlFixture(file: string): string {
  switch (file) {
    case 'orchestration-plan.html':
      return '<html>TEST-PRD Test Project demo foundation</html>';
    case 'agent-profiles.html':
      return "<html>fetchJSON('profiles.json') fetchJSON('prd.json')</html>";
    case 'pipeline-stages.html':
      return '<html>profiles.json phase-gates.jsonl foundation</html>';
    case 'quality-assurance.html':
      return '<html>phase-gates.jsonl fetch(</html>';
    default:
      return `<html>${file}</html>`;
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('DashboardHydrator', () => {
  it('fails when required inputs are missing', async () => {
    const projectRoot = await makeTempProject();
    await expect(hydrateDashboards({ targetPath: projectRoot })).rejects.toThrow(
      'Dashboard hydration missing required file',
    );
  });

  it('builds and verifies managed dashboards', async () => {
    const projectRoot = await makeTempProject();
    await setupProject(projectRoot);

    const liveDir = resolve(projectRoot, 'orchestrations', 'dashboards', 'live');
    await mkdir(liveDir, { recursive: true });
    for (const file of MANAGED_DASHBOARD_FILES) {
      await writeFile(join(liveDir, file), htmlFixture(file), 'utf-8');
    }
    await writeFile(join(liveDir, 'profiles.json'), JSON.stringify({
      'spec-coordinator-agent': 'x',
      'pipeline-engineer': 'x',
    }), 'utf-8');
    await writeFile(join(liveDir, 'prd.json'), JSON.stringify({
      id: 'TEST-PRD',
      title: 'Test Project',
      project: { name: 'demo' },
      implementationOrder: { foundation: ['TEST-001'] },
    }), 'utf-8');

    vi.mocked(execa).mockResolvedValue({} as never);

    const result = await hydrateDashboards({
      targetPath: projectRoot,
      requiredRoles: ['pipeline-engineer'],
    });

    expect(result.builtFiles).toHaveLength(MANAGED_DASHBOARD_FILES.length);
    expect(vi.mocked(execa)).toHaveBeenCalled();
    const seeded = await readFile(join(projectRoot, 'orchestrations', 'logs', 'agent-status.json'), 'utf-8');
    expect(seeded).toContain('"status": "idle"');
  });
});
