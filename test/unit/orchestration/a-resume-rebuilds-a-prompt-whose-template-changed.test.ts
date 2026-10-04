/**
 * A RESUME REBUILDS A PROMPT WHOSE TEMPLATE CHANGED — AND KEEPS EVERY OTHER ONE.
 *
 * 2026-10-04: the analysts were to receive the detective's fix sites through a new placeholder in
 * their templates. A run resumes with keepExisting, which kept every installed project prompt
 * byte-for-byte — never comparing the derivedFromSha256 each copy records against its template. So a
 * template correction could not reach a resumed run at all: the project went on executing the copy
 * made from the old template, and nothing said so. (The completeness check already compares the
 * template layer; it was the keep that ignored it.)
 *
 * EXECUTED: the real buildProjectPrompts, on a scratch template layer, verbatim (copy) and generated
 * (a model that answers from its input, as the other builder tests use).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const builder = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-builder.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contract = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-contract.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Answers from its input: every segment it is shown, back under its marker. */
const echoModel = async (prompt: string) => {
  const shown: string[] = [];
  const re = /^--- SEGMENT (\d+) ---\n([\s\S]*?)(?=^--- (?:SEGMENT \d+|END SEGMENTS) ---$)/gm;
  let m; while ((m = re.exec(prompt))) shown.push(m[2].replace(/\n$/, ''));
  return contract.formatSegments(shown);
};

const template = (body: string, placeholders: string[]) => ({
  id: 'scratch-analyst', layer: 'project', version: 1, description: 'scratch', placeholders, body,
});

function project(mode: 'copy' | 'generate') {
  const dir = mkdtempSync(join(tmpdir(), 'resume-template-')); dirs.push(dir);
  const cfg = join(dir, 'project'); mkdirSync(cfg, { recursive: true });
  const templates = join(dir, 'templates'); mkdirSync(templates, { recursive: true });
  const gen = builder.PROJECT_PROMPT_GENERATOR_ID;
  writeFileSync(join(templates, `${gen}.json`), readFileSync(join(TEMPLATES, `${gen}.json`), 'utf8'));
  const bootstrapFile = join(dir, 'bootstrap.json');
  writeFileSync(bootstrapFile, JSON.stringify(mode === 'copy'
    ? { copyVerbatim: [gen, 'scratch-analyst'], generated: [] }
    : { copyVerbatim: [gen], generated: ['scratch-analyst'] }));
  const write = (t: object) => writeFileSync(join(templates, 'scratch-analyst.json'), JSON.stringify(t, null, 2));
  const logs: string[] = [];
  const provision = (keepExisting: boolean) => builder.buildProjectPrompts({
    templatesDir: templates, projectConfigDir: cfg, bootstrapFile, mode,
    projectContext: 'a project', codelineContext: 'a codeline', mintedRoles: 'roles', attempts: 1,
    log: (msg: string) => logs.push(String(msg)), runText: echoModel, keepExisting,
  });
  const installed = () => JSON.parse(readFileSync(join(cfg, 'prompts', 'scratch-analyst.json'), 'utf8'));
  const raw = () => readFileSync(join(cfg, 'prompts', 'scratch-analyst.json'), 'utf8');
  return { write, provision, installed, raw, logs };
}

const V1 = template('STORY: __STORY_ID__\nDiagnose the failure.\n', ['__STORY_ID__']);
const V2 = template('STORY: __STORY_ID__\nWHERE THE DETECTIVE FOUND THE FIX:\n__FIX_SITES__\nDiagnose the failure.\n', ['__FIX_SITES__', '__STORY_ID__']);

for (const mode of ['copy', 'generate'] as const) {
  describe(`a resume and a changed template (${mode === 'copy' ? 'verbatim' : 'generated'} prompt)`, () => {
    it('the copy made from the old template is rebuilt from the new one', async () => {
      const p = project(mode);
      p.write(V1); await p.provision(false);
      expect(p.raw(), 'the first provisioning installed nothing').toContain('Diagnose the failure.');
      expect(p.raw()).not.toContain('__FIX_SITES__');
      p.write(V2); await p.provision(true);
      expect(p.raw(), 'the resume kept the copy of the OLD template').toContain('__FIX_SITES__');
    });

    it('an unchanged template keeps its installed copy byte for byte', async () => {
      const p = project(mode);
      p.write(V1); await p.provision(false);
      const before = p.raw();
      await p.provision(true);
      expect(p.raw()).toBe(before);
      expect(p.logs.join('\n')).toMatch(/kept scratch-analyst/);
    });
  });
}
