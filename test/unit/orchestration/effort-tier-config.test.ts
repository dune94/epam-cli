/**
 * ITERATION AND TOKEN BUDGETS ARE SETTINGS, NOT LITERALS IN A CASE STATEMENT.
 *
 * claude.sh set them inline per effort tier:
 *
 *   low)  STORY_MAX_ITERATIONS=6  ; STORY_MAX_OUTPUT_TOKENS=3072
 *   high) STORY_MAX_ITERATIONS=15 ; STORY_MAX_OUTPUT_TOKENS=6144
 *   generator role: 3 / 16384
 *
 * These are exactly the knobs an operator tunes when a run burns its budget or a model
 * truncates its answer — and they were invisible, in a 10,000-line shell script, with no
 * way to change one without editing code. llm-settings.json already owns ladders, retries,
 * timeouts and cost controls; this belongs beside them.
 *
 * Two tiers, so a project need not restate what it does not change:
 *   orchestrations/config/llm-defaults.json   engine-wide defaults
 *   projects/<name>/llm-settings.json         per-project override
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const DEFAULTS = join(REPO, 'orchestrations/config/llm-defaults.json');
const CLAUDE_SH = join(REPO, 'orchestrations/scripts/claude.sh');

/** Run the REAL loader and report the resolved values. */
function loadTiers(projectConfigDir = '') {
  const script = join(mkdtempSync(join(tmpdir(), 'tiers-')), 'run.sh');
  writeFileSync(
    script,
    [
      'set -uo pipefail',
      'log(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }; info(){ :; }',
      `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(projectConfigDir)}`,
      // claude.sh sets AUTOMATION_DIR at line 21; the extracted loader needs it to find
      // the engine-wide defaults, so the harness must provide what the real script does.
      `AUTOMATION_DIR=${JSON.stringify(join(REPO, 'orchestrations'))}`,
      // pull in only the loader, not the whole orchestration script
      `eval "$(sed -n '/^load_llm_settings_json() {/,/^}/p' ${JSON.stringify(CLAUDE_SH)})"`,
      'load_llm_settings_json',
      'echo "LOW_ITER=${EPAM_EFFORT_LOW_MAX_ITERATIONS:-}"',
      'echo "LOW_TOK=${EPAM_EFFORT_LOW_MAX_OUTPUT_TOKENS:-}"',
      'echo "HIGH_ITER=${EPAM_EFFORT_HIGH_MAX_ITERATIONS:-}"',
      'echo "GEN_TOK=${EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS:-}"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout || ''}`;
  const get = (k: string) => (new RegExp(`${k}=(.*)`).exec(out)?.[1] ?? '').trim();
  return { LOW_ITER: get('LOW_ITER'), LOW_TOK: get('LOW_TOK'), HIGH_ITER: get('HIGH_ITER'), GEN_TOK: get('GEN_TOK'), out, err: r.stderr };
}

describe('effort budgets come from configuration', () => {
  it('the engine-wide defaults file exists', () => {
    expect(existsSync(DEFAULTS), 'settings an operator tunes must live where they can find them').toBe(true);
  });

  it('it declares every effort tier and the role overrides', () => {
    const cfg = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
    for (const tier of ['low', 'medium', 'high']) {
      expect(cfg.effortTiers?.[tier]?.maxIterations, `${tier}.maxIterations missing`).toBeGreaterThan(0);
      expect(cfg.effortTiers?.[tier]?.maxOutputTokens, `${tier}.maxOutputTokens missing`).toBeGreaterThan(0);
    }
    expect(cfg.roleOverrides?.generator?.maxOutputTokens).toBeGreaterThan(0);
  });

  it('the loader resolves them', () => {
    const cfg = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
    const r = loadTiers();
    expect(r.LOW_ITER, `loader produced nothing:\n${r.out}${r.err}`).toBe(String(cfg.effortTiers.low.maxIterations));
    expect(r.HIGH_ITER).toBe(String(cfg.effortTiers.high.maxIterations));
    expect(r.GEN_TOK).toBe(String(cfg.roleOverrides.generator.maxOutputTokens));
  });

  it('a project can override a single tier without restating the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'));
    writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify({ effortTiers: { low: { maxIterations: 99 } } }));
    const cfg = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
    const r = loadTiers(dir);
    expect(r.LOW_ITER, 'project override ignored').toBe('99');
    expect(r.LOW_TOK, 'untouched value should fall back to the engine default')
      .toBe(String(cfg.effortTiers.low.maxOutputTokens));
  });

  it('claude.sh no longer assigns these budgets as literals', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(
      src,
      'an inline budget means the config file is decoration and the real value is still in code',
    ).not.toMatch(/STORY_MAX_(ITERATIONS|OUTPUT_TOKENS)=[0-9]+/);
  });
});
