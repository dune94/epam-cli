/**
 * _run_jira_pipeline's synthesized PRD path — must be overridable.
 *
 * Real bug (2026-07-23): _synth_prd was hardcoded to
 * "$AUTOMATION_DIR/travel-app-prd.json" — the exact file the real Metrolinx
 * run uses. Any test or isolated run of the Jira-ingest pipeline would
 * silently overwrite that real project's PRD. Fixed to respect
 * JIRA_SYNTH_PRD_PATH when set, defaulting to the original path otherwise
 * (zero behavior change for every real caller, which never sets it).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('run-agent-orchestration.sh — _run_jira_pipeline synthesized PRD path is overridable', () => {
  it('the source declares _synth_prd overridable, falling back to the run\'s own PRD_FILE', () => {
    // CONTRACT CHANGED 2026-07-25. The default used to be travel-app-prd.json
    // outright, which meant every Jira-driven project synthesized into the
    // TRAVEL-APP PRD: a metrolinx run replaced its 4 SKY stories with a single
    // AMSD-1820 story. The run's own PRD_FILE now takes precedence, with the old
    // path kept as the innermost fallback so nothing that relied on it breaks.
    expect(orchSrc).toMatch(/_synth_prd="\$\{JIRA_SYNTH_PRD_PATH:-\$\{PRD_FILE:-\$AUTOMATION_DIR\/travel-app-prd\.json\}\}"/);
  });

  it('REAL execution: with JIRA_SYNTH_PRD_PATH set, the resolved value is the override, not the default', () => {
    const startMarker = 'local _synth_prd=';
    const idx = orchSrc.indexOf(startMarker);
    expect(idx).toBeGreaterThan(-1);
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    const script = [
      '#!/usr/bin/env bash',
      'AUTOMATION_DIR=/should/not/be/used',
      'f() {',
      line,
      'echo "$_synth_prd"',
      '}',
      'f',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, JIRA_SYNTH_PRD_PATH: '/tmp/mock-disposable-prd.json' },
    }).trim();
    expect(out).toBe('/tmp/mock-disposable-prd.json');
  });

  it('REAL execution: with JIRA_SYNTH_PRD_PATH unset, falls back to the original AUTOMATION_DIR/travel-app-prd.json default', () => {
    const startMarker = 'local _synth_prd=';
    const idx = orchSrc.indexOf(startMarker);
    const line = orchSrc.slice(idx, orchSrc.indexOf('\n', idx));
    const script = [
      '#!/usr/bin/env bash',
      'AUTOMATION_DIR=/fake/automation/dir',
      'f() {',
      line,
      'echo "$_synth_prd"',
      '}',
      'f',
    ].join('\n');
    const env = { ...process.env };
    delete env.JIRA_SYNTH_PRD_PATH;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim();
    expect(out).toBe('/fake/automation/dir/travel-app-prd.json');
  });
});
