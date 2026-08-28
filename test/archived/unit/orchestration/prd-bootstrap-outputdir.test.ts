/**
 * Every project's PRD must exist BEFORE the run starts, with a valid outputDir.
 *
 * run-agent-orchestration.sh:76 reads project.outputDir from $PRD_FILE at STARTUP,
 * and :82-91 aborts if PROJECT_ROOT resolves to the epam-cli repo itself. The Jira
 * ingest that writes the PRD runs LATER, inside the phase — so the PRD cannot be
 * the ingest's first output; something must already be there to bootstrap from.
 *
 * This killed the 2026-07-25 12:02 launch instantly:
 *     ERROR: PROJECT_ROOT resolves to the epam-cli repo root
 * The per-project PRD path (projects/metrolinx/prd.json) had no file yet, so
 * outputDir read as empty. Previously the leftover travel-app-prd.json from the
 * last run happened to serve as the bootstrap — which is also exactly why the
 * cross-project clobber went unnoticed for so long.
 *
 * Second requirement here: the SYNTHESIS TEMPLATE must be the project's own.
 * synthesize-prd-from-jira.js:202 does `const project = { ...template.project }`,
 * so the template supplies outputDir wholesale. With JIRA_PRD_TEMPLATE unset it
 * falls back to travel-app-prd.canonical.json, whose outputDir is
 * /home/bradleyjerome/projects/skyscanner-app — the wrong repo entirely.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const PROJECTS = join(ROOT, 'orchestrations/projects');

const projects = ['metrolinx'];   // projects driven by the Jira ingest

describe.each(projects)('%s — PRD bootstrap', (proj) => {
  const dir = join(PROJECTS, proj);

  it('has a PRD present before the run starts', () => {
    expect(existsSync(join(dir, 'prd.json')),
      `${proj}/prd.json missing — the startup outputDir read yields "" and the ` +
      `run aborts on the PROJECT_ROOT guard before the ingest ever runs`).toBe(true);
  });

  it('its outputDir points outside the epam-cli repo', () => {
    const prd = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'));
    const out = prd.project?.outputDir ?? '';
    expect(out, 'no project.outputDir').toBeTruthy();
    expect(out.startsWith(ROOT.replace(/\/$/, '')),
      `outputDir is inside the epam-cli repo (${out}) — the guard aborts`).toBe(false);
  });

  it('has its own synthesis template, not another project\'s', () => {
    expect(existsSync(join(dir, 'prd.canonical.json')),
      `${proj} has no prd.canonical.json, so synthesize falls back to ` +
      `travel-app-prd.canonical.json and inherits ITS project.outputDir`).toBe(true);
  });

  it('the template\'s outputDir matches the project, not travel-app/skyscanner', () => {
    const tmpl = JSON.parse(readFileSync(join(dir, 'prd.canonical.json'), 'utf8'));
    expect(tmpl.project?.outputDir ?? '').not.toMatch(/skyscanner-app|travel-app/);
  });

  it('the template carries no completed story state (clean slate every run)', () => {
    const tmpl = JSON.parse(readFileSync(join(dir, 'prd.canonical.json'), 'utf8'));
    const dirty = (tmpl.stories ?? []).filter((s: any) => s.completed || (s.status && s.status !== 'pending'));
    expect(dirty.map((s: any) => `${s.id}:${s.status}`), 'template carries prior-run state').toEqual([]);
  });

  it('JIRA_PRD_TEMPLATE is configured to that template', () => {
    const cfg = readFileSync(join(dir, 'config.env'), 'utf8');
    const m = cfg.match(/^JIRA_PRD_TEMPLATE=(.+)$/m);
    expect(m, 'JIRA_PRD_TEMPLATE unset — synthesize falls back to travel-app').toBeTruthy();
    expect(m![1]).toContain(`projects/${proj}/prd.canonical.json`);
  });
});
