/**
 * AN INPUT NOBODY PRODUCED IS NOT AN INPUT.
 *
 * The topology router decides whether a phase runs as one lane or several. Its caller built the
 * router's payload with jq, and when that failed:
 *
 *     }' 2>/dev/null || echo '{"phase":"","stories":[],"cpaSignals":[]}'
 *
 * a well-formed object with nothing in it. topology-router.js then refused to render — "prompt
 * 'topology-router' was given EMPTY values for: __PHASE__" — its stderr went to /dev/null, and the
 * heuristic ran with nobody aware the model router had been skipped.
 *
 * The heuristic is a perfectly good outcome. Being unable to tell it apart from a model's decision
 * is not: the run reports a topology with no way to know what chose it.
 *
 * The empty-phase refusal is asserted by RENDERING the real template, so this is grounded in what
 * the renderer does rather than in a claim about it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

/** Render the real topology-router template with the given phase. */
function render(phase: string) {
  const proj = mkdtempSync(join(tmpdir(), 'topology-'));
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(join(REPO, 'orchestrations/prompts/templates/topology-router.json'),
    join(proj, 'prompts/topology-router.json'));
  const r = spawnSync(process.execPath, ['-e', `
    process.env.EPAM_PROJECT_CONFIG_DIR = ${JSON.stringify(proj)};
    const { renderEngineTemplate } = require(${JSON.stringify(join(REPO, 'orchestrations/scripts/lib/engine-prompt.js'))});
    try {
      const out = renderEngineTemplate('topology-router', {
        __PHASE__: ${JSON.stringify(phase)}, __STORIES__: '- S-1: a story', __CPA_SIGNALS__: '- none',
      });
      process.stdout.write('RENDERED:' + out.length);
    } catch (e) { process.stdout.write('REFUSED:' + e.message); }
  `], { encoding: 'utf8', timeout: 60000, cwd: REPO });
  return (r.stdout ?? '').trim();
}

describe('an input nobody produced is not an input', () => {
  it('the router renders with a real phase', () => {
    expect(render('core'), 'the template no longer renders at all').toMatch(/^RENDERED:\d+/);
  }, 60_000);

  it('and REFUSES an empty one — which is why fabricating a payload is not harmless', () => {
    expect(render(''), 'an empty phase renders, so the premise below no longer holds')
      .toMatch(/^REFUSED:.*__PHASE__/);
  }, 60_000);

  it('the caller no longer invents a payload when it cannot build one', () => {
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the caller still falls back to a well-formed but empty router input')
      .not.toMatch(/\|\| echo '\{"phase":"","stories":\[\],"cpaSignals":\[\]\}'/);
  });

  it('it says the model router was skipped, so the heuristic is not mistaken for a decision', () => {
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the skip is silent — the topology cannot be told from a model-chosen one')
      .toMatch(/SKIPPING the model router/);
  });

  it('and the router is not called at all without a payload', () => {
    // Calling it with an empty string would reach the same refusal, just later and more quietly.
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the router is still invoked unconditionally')
      .toMatch(/\[ -n "\$_stories_payload" \] && _router_out=/);
  });
});
