/**
 * EVERY PROJECT DECLARES HOW ITS PROMPTS ARE PROVISIONED.
 *
 * The mint refuses to guess — "EPAM_PROMPT_PROVISION_MODE is unset … there is no engine default"
 * — and the generic launcher refuses at launch for the same reason. Two of the four projects in
 * this repository declared nothing: the greenfield rehearsal project (its test exported the value
 * for it) and the brownfield rehearsal project (every launch died at the mint, 2026-09-13). A
 * project is data; data that cannot be launched is not a project. The universe is every project
 * directory, so a project added tomorrow is covered by existing.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECTS = join(__dirname, '../../../orchestrations/projects');
const projects = readdirSync(PROJECTS).filter((d) => existsSync(join(PROJECTS, d, 'config.env')));

describe('every project declares how its prompts are provisioned', () => {
  it('there are projects to check', () => { expect(projects.length).toBeGreaterThan(0); });
  it.each(projects)('%s declares EPAM_PROMPT_PROVISION_MODE as copy or generate', (p) => {
    const cfg = readFileSync(join(PROJECTS, p, 'config.env'), 'utf8');
    const m = cfg.match(/^EPAM_PROMPT_PROVISION_MODE=(.*)$/m);
    expect(m, `${p}/config.env declares no EPAM_PROMPT_PROVISION_MODE — the mint would refuse mid-run`).toBeTruthy();
    expect(['copy', 'generate']).toContain(m![1].trim().replace(/^["']|["']$/g, ''));
  });
});
