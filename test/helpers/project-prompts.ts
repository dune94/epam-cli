/**
 * A PROJECT-AUTHORITY PROMPT DIRECTORY FOR TESTS.
 *
 * The pipeline never executes a prompt template: a project-authority copy is what runs, and an
 * agent whose prompt will not render is refused rather than invoked with no instructions. So any
 * test that drives a real agent step must supply that directory, exactly as a project does.
 *
 * Every template is copied, none named — a test helper that lists prompt ids becomes another
 * place to update each time one is added.
 */
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');

const dirs: string[] = [];

/** @returns a directory usable as EPAM_PROJECT_CONFIG_DIR. */
export function mintProjectPrompts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-prompts-'));
  dirs.push(dir);
  const prompts = join(dir, 'prompts');
  mkdirSync(prompts, { recursive: true });
  for (const f of readdirSync(TEMPLATES)) {
    if (f.endsWith('.json')) copyFileSync(join(TEMPLATES, f), join(prompts, f));
  }
  return dir;
}

export function cleanupProjectPrompts(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
