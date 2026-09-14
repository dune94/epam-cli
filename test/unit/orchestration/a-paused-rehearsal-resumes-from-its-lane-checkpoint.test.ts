/**
 * A PAUSED REHEARSAL RESUMES FROM ITS LANE CHECKPOINT.
 *
 * The orchestrator saves a lane's checkpoint under runs/<id>/lanes/<codeline>/checkpoint (since
 * lanes came in); mock1-paused-run.sh --resume looked only at runs/<id>/checkpoint, so every
 * paused rehearsal refused to resume with "no checkpoint" while its checkpoint sat one directory
 * down (£0 brownfield harness run 4, 2026-09-14). The launcher asks the checkpoint library.
 *
 * Judged by executing the real launcher's --resume against an install of this test's own: the
 * real scripts, a run that left only a lane checkpoint, a workspace to resume against, and a
 * stub in place of the pipeline it hands over to.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('a paused rehearsal resumes from its lane checkpoint', () => {
  it('--resume finds a run whose only checkpoint is under lanes/<codeline>/ and hands over to the pipeline', () => {
    const root = mkdtempSync(join(tmpdir(), 'paused-')); dirs.push(root);
    // The install: the real scripts and libraries, the fixture tracker, and a stub pipeline.
    cpSync(join(ROOT, 'orchestrations/scripts'), join(root, 'orchestrations/scripts'), { recursive: true });
    cpSync(join(ROOT, 'orchestrations/agents'), join(root, 'orchestrations/agents'), { recursive: true });
    mkdirSync(join(root, 'test/fixtures/mock-pipeline'), { recursive: true });
    cpSync(join(ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js'), join(root, 'test/fixtures/mock-pipeline/mock-jira-server.js'));
    writeFileSync(join(root, 'orchestrations/scripts/tier3-mock-run.sh'), '#!/bin/bash\necho "STUB PIPELINE RAN: $*"\nexit 0\n');
    chmodSync(join(root, 'orchestrations/scripts/tier3-mock-run.sh'), 0o755);
    // The mock registration, recording which PRD it was handed: on a resume the run's synthesised
    // PRD exists and carries the stories' deliverables; registered from the tracker alone, the
    // writer had no files to land and answered eight times with the generic text (run 9).
    writeFileSync(join(root, 'orchestrations/scripts/mock-expectations.js'), 'process.stdout.write("REGISTERED PRD_FILE=" + (process.env.PRD_FILE || "") + "\\n");\n');
    // The project: a seed (so the launcher owns it) and a run that paused with a LANE checkpoint.
    const project = join(root, 'orchestrations/projects/paused-proj'); mkdirSync(join(project, 'seed', 'src'), { recursive: true });
    writeFileSync(join(project, 'seed', 'src', 'hello.ts'), "export const getGreeting = () => 'hello world';\n");
    writeFileSync(join(project, 'prd.authored.json'), JSON.stringify({ project: { name: 'paused-proj' }, stories: [] }));
    writeFileSync(join(project, 'config.env'), 'PROJECT_NAME=paused-proj\nEPAM_BROWNFIELD=1\n');
    // The project's tracker issues — the launcher serves the project's ticket, never one of its own.
    writeFileSync(join(project, 'tracker-issues.json'), JSON.stringify([{ key: 'PP-1', summary: 'a defect', description: 'fix it' }]));
    const rid = '20260914T000000Z';
    mkdirSync(join(project, 'runs', rid, 'lanes', 'mockhelloworld', 'checkpoint'), { recursive: true });
    writeFileSync(join(project, 'runs', rid, 'lanes', 'mockhelloworld', 'checkpoint', 'checkpoint.json'), JSON.stringify({ stage: 'pre-writer', runId: rid }));
    // The workspace the run paused against.
    const ws = join(root, 'ws'); const clone = join(ws, rid, 'workspace', 'codelines', 'mock-hello-world'); mkdirSync(clone, { recursive: true });
    writeFileSync(join(ws, rid, 'workspace', 'synthesized-prd.json'), JSON.stringify({ stories: [] }));
    spawnSync('git', ['-C', clone, 'init', '-q']);
    const r = spawnSync('bash', [join(root, 'orchestrations/scripts/mock1-paused-run.sh'), '--resume', rid], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: project, MOCK1_WORKSPACE_ROOT: ws, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: 'mockserver', EPAM_MOCK_BASE_URL: 'http://127.0.0.1:1' },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out, 'the launcher did not find the lane checkpoint').not.toMatch(/no checkpoint for run/);
    expect(out, 'the launcher did not hand over to the pipeline').toMatch(/STUB PIPELINE RAN/);
    expect(out, "on a resume the mock is registered from the run's synthesised PRD, which carries the deliverables")
      .toContain(`REGISTERED PRD_FILE=${join(ws, rid, 'workspace', 'synthesized-prd.json')}`);
  });
});
