/**
 * A FULLY PROVISIONED PROJECT, FOR £0.
 *
 * Thirty-two of the forty seams refuse to run without THIS PROJECT's copy of their prompt, and
 * those copies are produced by specialising each template through a model. I twice told the
 * operator that made them untestable without spending — "the first paid stage", "I can't test what
 * isn't there yet".
 *
 * That was wrong. buildProjectPrompts takes `runText` as a PARAMETER. I had checked that it calls a
 * model and never checked whether the call was injectable. It is, and always was.
 *
 * With a stub that returns each template's own body — which by construction carries every
 * placeholder the validator demands — provisioning produces all 41 prompts and costs nothing. The
 * copies are not SPECIALISED, so they say nothing about this project; what they are is
 * structurally real, which is the whole of what a seam needs in order to render and run.
 *
 * That is the difference between testing the pipeline offline and needing a paid run to find out.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(__dirname, '../..');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');

export interface ProvisionedProject {
  /** EPAM_PROJECT_CONFIG_DIR for the fixture. */
  dir: string;
  /** How many prompts were written. */
  count: number;
}

/**
 * Provision every prompt a seam might ask for, into a throwaway project directory.
 *
 * The stub returns the template's own body — every part of it, so a multi-body template keeps the
 * placeholders any part requires. A stub that paraphrased would be refused by the builder's own
 * validator, which is correct of it: a specialisation that drops a placeholder is a broken prompt.
 */
export async function provisionProject(opts: {
  projectContext?: string; codelineContext?: string; mintedRoles?: string;
} = {}): Promise<ProvisionedProject> {
  const dir = mkdtempSync(join(tmpdir(), 'provisioned-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { buildProjectPrompts } = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-builder.js'));
  await buildProjectPrompts({
    templatesDir: TEMPLATES,
    bootstrapFile: join(REPO, 'orchestrations/prompts/bootstrap.json'),
    registryFile: join(REPO, 'orchestrations/agents/invocation-profiles.json'),
    projectConfigDir: dir,
    projectContext: opts.projectContext ?? 'a fixture project',
    codelineContext: opts.codelineContext ?? '- alphashop (/tmp/alphashop)',
    mintedRoles: opts.mintedRoles ?? 'checkout-form-engineer',
    runText: async (_prompt: string, meta: { id: string }) => {
      try {
        const t = JSON.parse(readFileSync(join(TEMPLATES, `${meta.id}.json`), 'utf8'));
        return [String(t.body || ''), ...Object.values(t.bodies || {}).map(String)].join('\n\n');
      } catch { return ''; }
    },
  });

  return { dir, count: readdirSync(join(dir, 'prompts')).length };
}

/** A minimal roster the seams that demand an identity will accept. */
export function writeRoster(dir: string, agents: Record<string, { persona: string; kind: string }>) {
  writeFileSync(join(dir, 'roster.json'), JSON.stringify({ agents }, null, 2));
}
