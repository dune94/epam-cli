/**
 * A PROJECT'S IDENTITY COMES FROM THE PROJECT.
 *
 * ingest-jira-tickets.sh picks the synthesis template from JIRA_PRD_TEMPLATE and, when that
 * is unset, falls back to a built-in canonical belonging to ONE project. No project set the
 * variable, so every Jira-sourced run inherited that project's `project` block: mock1's run
 * 20260805T192100Z produced project.name "skyscanner-app" while running hello-dolly, and
 * writing hello-dolly its own prd.canonical.json changed nothing, because nothing read it.
 *
 * The project config directory is where a project's facts live and is already exported as
 * EPAM_PROJECT_CONFIG_DIR for every run. Deriving the template from it means a project owns
 * its identity by default rather than by remembering to set a variable.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/**
 * Runs the template-resolution block from ingest-jira-tickets.sh against fixtures. The
 * block is extracted rather than reimplemented, so a change to the script that breaks this
 * contract fails here instead of in a live run.
 */
function resolveTemplate(opts: {
  projectConfigDir?: string;
  jiraPrdTemplate?: string;
}): { chosen: string; out: string } {
  const src = readFileSync(join(SCRIPTS, 'ingest-jira-tickets.sh'), 'utf8');
  const start = src.indexOf('_synth_template_args=()');
  const end = src.indexOf('_out_prd_required', start);
  expect(start, 'template-resolution block not found in ingest-jira-tickets.sh').toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);

  const script = `
    set -uo pipefail
    log() { echo "[log] $*" >&2; }
    ${block}
    printf 'CHOSEN=%s\\n' "\${_synth_template_args[1]:-<none>}"
  `;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      EPAM_PROJECT_CONFIG_DIR: opts.projectConfigDir ?? '',
      JIRA_PRD_TEMPLATE: opts.jiraPrdTemplate ?? '',
    },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { chosen: (out.match(/CHOSEN=(.*)/) || [])[1] || '', out };
}

function projectDir(withCanonical: boolean, name = 'a-project') {
  const dir = mkdtempSync(join(tmpdir(), 'pcfg-'));
  mkdirSync(dir, { recursive: true });
  if (withCanonical) {
    writeFileSync(
      join(dir, 'prd.canonical.json'),
      JSON.stringify({ project: { name }, stories: [] }),
    );
  }
  return dir;
}

describe('the project supplies its own template', () => {
  it('THE BUG: a project with a canonical uses ITS canonical, not another project\'s', () => {
    const dir = projectDir(true);
    const { chosen, out } = resolveTemplate({ projectConfigDir: dir });
    expect(
      chosen,
      `run 20260805T192100Z ran hello-dolly and produced project.name "skyscanner-app" ` +
        `because this resolved to a built-in canonical. out:\n${out}`,
    ).toBe(join(dir, 'prd.canonical.json'));
  });

  it('an explicit JIRA_PRD_TEMPLATE still wins — configuration overrides derivation', () => {
    const dir = projectDir(true);
    const explicit = join(mkdtempSync(join(tmpdir(), 'explicit-')), 'mine.json');
    writeFileSync(explicit, JSON.stringify({ project: { name: 'explicit' } }));
    const { chosen } = resolveTemplate({ projectConfigDir: dir, jiraPrdTemplate: explicit });
    expect(chosen).toBe(explicit);
  });

  it('a project with no canonical says so loudly rather than borrowing in silence', () => {
    const dir = projectDir(false);
    const { chosen, out } = resolveTemplate({ projectConfigDir: dir });
    expect(chosen).toBe('<none>');
    expect(
      out,
      'silently inheriting another project\'s identity is how this went unnoticed for ' +
        'every Jira-sourced run',
    ).toMatch(/canonical|identity|template/i);
  });

  it('no project config dir at all behaves as before — existing callers unaffected', () => {
    const { chosen } = resolveTemplate({});
    expect(chosen).toBe('<none>');
  });

  it('a configured path that does not exist does not silently become the derived one', () => {
    const dir = projectDir(true);
    const { chosen, out } = resolveTemplate({
      projectConfigDir: dir,
      jiraPrdTemplate: '/nonexistent/template.json',
    });
    expect(out, 'a set-but-missing template must be reported').toMatch(/not found|WARN/i);
    expect(
      chosen,
      'falling through to the derived template would hide the operator\'s typo',
    ).not.toBe('/nonexistent/template.json');
  });
});
