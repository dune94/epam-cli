// THE TEST TIMEOUT WAS THE ONE TIMEOUT A PROJECT COULD NOT DECLARE.
//
// metrolinx's config.env records that timeouts were REMOVED from it and consolidated into
// llm-settings.json, "so there is exactly one authoritative copy" — after EPAM_STORY_TIMEOUT_SECS
// had already drifted (690 in one file, 600 in another).
//
// EPAM_TEST_TIMEOUT_SECS never joined them. The loader maps secondsPerIteration,
// storyTimeoutMaxSecs, storyTimeoutSecs and gateTimeoutSecs; the test timeout stayed a bare
// ${EPAM_TEST_TIMEOUT_SECS:-300} at six call sites with no declared source. Raising it for a
// project meant putting it back in config.env — recreating the duplication that consolidation
// removed.
//
// 300s is a real constraint on this codeline: 245 jest test files plus a `pretest` that runs
// esbuild over next.config.source.ts. When `timeout` kills the suite the result is reported as
// FAILING TESTS, not as a timeout.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

/** Runs the REAL loader against a settings file and reports what it exported. */
function loadSettings(timeouts: Record<string, number>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'llmset-'));
  // The loader takes no argument: it reads $EPAM_PROJECT_CONFIG_DIR/llm-settings.json.
  writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify({ timeouts }, null, 2));
  const script = `
set +e
log() { :; }; warning() { :; }; info() { :; }; error() { :; }
export EPAM_PROJECT_CONFIG_DIR="${dir}"
eval "$(awk '/^load_llm_settings_json\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"
load_llm_settings_json >/dev/null 2>&1
echo "TEST=\${EPAM_TEST_TIMEOUT_SECS:-}"
echo "GATE=\${EPAM_GATE_TIMEOUT_SECS:-}"
`;
  const out = spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout || '';
  rmSync(dir, { recursive: true, force: true });
  return {
    test: (out.match(/TEST=(.*)/) || [])[1] ?? '',
    gate: (out.match(/GATE=(.*)/) || [])[1] ?? '',
  };
}

describe('a project can declare its test timeout where its other timeouts live', () => {
  it('the loader is actually running — otherwise this proves nothing', () => {
    expect(loadSettings({ gateTimeoutSecs: 2400 }).gate,
      'load_llm_settings_json exported nothing; the harness is not exercising it').toBe('2400');
  });

  it('THE DEFECT: timeouts.testTimeoutSecs reaches EPAM_TEST_TIMEOUT_SECS', () => {
    expect(loadSettings({ testTimeoutSecs: 1000 }).test,
      'the one timeout a project cannot declare — raising it means duplicating it in config.env')
      .toBe('1000');
  });

  it('declaring nothing leaves it unset, so the call-site default still applies', () => {
    expect(loadSettings({ gateTimeoutSecs: 2400 }).test).toBe('');
  });
});

describe('the schema admits the field it is now read from', () => {
  it('llm-settings.schema.json declares testTimeoutSecs', () => {
    // additionalProperties is false on timeouts, so an undeclared field is a validation error.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schema = require(join(ROOT, 'orchestrations/config/llm-settings.schema.json'));
    const props = schema.properties?.timeouts?.properties ?? {};
    expect(Object.keys(props), 'the schema rejects the field the loader now reads')
      .toContain('testTimeoutSecs');
  });
});
