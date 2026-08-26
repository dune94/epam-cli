/**
 * PER-MODEL OVERRIDES MUST REACH THE RUN — FROM WHEREVER THEY ARE DECLARED.
 *
 * claude.sh's model-override resolver read exactly one file:
 * `${EPAM_PROJECT_CONFIG_DIR}/llm-settings.json`. The 2026-08-25 migration moved
 * `modelOverrides` out of the project files and into `config/llm-defaults.<set>.json`,
 * because a per-model setting belongs to the model and a model belongs to a stack.
 * The reader was left behind. The file still existed, so no branch failed and nothing
 * logged — it simply held no overrides, and thinking mode, prompt-cache TTL,
 * compaction thresholds and output caps reached NOTHING on any run, on any stack.
 *
 * This is the second reader of that class; seam-invocation.js had the identical defect
 * for iteration budgets. Both are silent: the value is absent, not wrong.
 *
 * The test drives the REAL resolver block out of claude.sh against a project settings
 * file shaped like production's (no modelOverrides) and asserts the declared value
 * arrives anyway, from the active stack.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_DIR = join(REPO_ROOT, 'orchestrations/scripts');
const claudeSrc = readFileSync(join(SCRIPT_DIR, 'claude.sh'), 'utf8');
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

function effortHelpers(): string {
  return ['effort_rank', 'max_effort', 'next_effort'].map((n) => {
    const m = new RegExp(`^${n}\\(\\) \\{$`, 'm').exec(claudeSrc);
    if (!m) return '';
    return claudeSrc.slice(m.index, claudeSrc.indexOf('\n}\n', m.index) + 3);
  }).join('\n');
}

function resolverBlock(): string {
  const start = claudeSrc.indexOf('local _effective_max_iterations="${STORY_MAX_ITERATIONS:-6}"');
  const marker = claudeSrc.indexOf('ModelOverride[', start);
  const TERM = '\n                fi\n';
  const end = claudeSrc.indexOf(TERM, marker) + TERM.length;
  return claudeSrc.slice(start, end);
}

/** Run the real block with a project settings file and a declared active stack. */
function resolve(opts: { projectSettings: object; set: string; model: string; provider: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'override-stack-'));
  try {
    writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify(opts.projectSettings));
    const sh = join(dir, 'run.sh');
    writeFileSync(sh, [
      `SCRIPT_DIR="${SCRIPT_DIR}"`,
      `NODE_BIN="${NODE_BIN}"`,
      `EPAM_PROJECT_CONFIG_DIR="${dir}"`,
      `EPAM_PROVIDER_SET="${opts.set}"`,
      `export EPAM_PROVIDER_SET`,
      `STORY_PROVIDER="${opts.provider}"`,
      `STORY_MODEL="${opts.model}"`,
      `log() { :; }`,
      `warning() { :; }`,
      effortHelpers(),
      `resolve_override() {`,
      resolverBlock(),
      `  echo "compress_at=\${_effective_compress_at:-}"`,
      `  echo "effort=\${EPAM_REASONING_EFFORT:-}"`,
      `}`,
      `resolve_override`,
      `exit 0`,
    ].join('\n'));
    const out = execFileSync('bash', [sh], { encoding: 'utf8' });
    const r: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) r[line.slice(0, i)] = line.slice(i + 1);
    }
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('per-model overrides reach the run from the active stack', () => {
  it('the harness drives the real block, not an empty string', () => {
    expect(resolverBlock().split('\n').length).toBeGreaterThan(20);
    expect(existsSync(NODE_BIN), `node 20 missing at ${NODE_BIN}`).toBe(true);
  });

  it('THE DEFECT: a project settings file with no modelOverrides still gets the stack value', () => {
    const stack = JSON.parse(
      readFileSync(join(REPO_ROOT, 'orchestrations/config/llm-defaults.claude.json'), 'utf8'));
    const declared = Object.entries<any>(stack.modelOverrides || {})
      .filter(([k]) => !k.startsWith('$'))
      .find(([, v]) => v && v.autoCompressAt);
    expect(declared, 'the claude stack declares no autoCompressAt to prove with').toBeTruthy();
    const [, spec] = declared!;

    // Production's own shape: the project file exists and declares no overrides.
    const r = resolve({
      projectSettings: { defaultProvider: 'claude' },
      set: 'claude',
      model: spec.matchSubstring,
      provider: 'claude',
    });
    expect(r.compress_at).toBe(String(spec.autoCompressAt));
  });

  it('a project that DOES declare overrides still wins — the project layer is not overruled', () => {
    const r = resolve({
      projectSettings: {
        modelOverrides: {
          pinned: { matchOn: 'model', matchSubstring: 'claude-sonnet-5', autoCompressAt: 4242 },
        },
      },
      set: 'claude',
      model: 'claude-sonnet-5',
      provider: 'claude',
    });
    expect(r.compress_at).toBe('4242');
  });
});
