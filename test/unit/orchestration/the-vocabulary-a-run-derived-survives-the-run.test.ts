/**
 * THE FILTER THAT CHOSE THE REPOSITORY MUST OUTLIVE THE RUN THAT APPLIED IT.
 *
 * A model call derives a per-ticket vocabulary — which terms carry selection signal and which are
 * noise — and codeline scoring applies it to decide which client repository gets modified. Its own
 * comment says why it is written down:
 *
 *     "PERSISTED, because it is generated and because it is the only evidence of what the filter
 *      actually did. The count in a log line says a vocabulary was DERIVED; this file says which
 *      terms were APPLIED, which is the part that changes the repository chosen."
 *
 * It was written beside the discovery OUTPUT, and every caller points that output at a temp
 * directory it deletes on exit — the ingest into $TMPDIR_INGEST, the scope resolver into an
 * mktemp -d under a trap. So the file has never survived a single run, and nothing has ever read
 * it. spec-mode-runner.js names the mistake in its own comment while avoiding it:
 *
 *     "Documents go beside the rest of the run's evidence rather than into a temp directory that
 *      teardown deletes — the mistake made with discovery-vocabulary.json."
 *
 * Paid output nothing can read is the defect either way: fix where it lands, or stop deriving it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'vocab-survives-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function stubAiRun(root: string): string {
  const p = join(work, 'stub-ai-run.sh');
  writeFileSync(p, [
    '#!/usr/bin/env bash',
    '_p=""; for a in "$@"; do [ -f "$a" ] && _p="$a"; done',
    '_t="$( [ -n "$_p" ] && cat "$_p" || cat )"',
    `if printf '%s' "$_t" | grep -qi 'DISCOVERY_VOCABULARY'; then`,
    `  echo '<DISCOVERY_VOCABULARY>'`,
    `  echo '{"blacklist":[{"term":"service","reason":"shared by every candidate","kind":"noise"}],"whitelist":[{"term":"alpha","reason":"names a candidate"}]}'`,
    `  echo '</DISCOVERY_VOCABULARY>'`,
    'else',
    `  echo '{"codelines":[{"name":"alpha-service","path":"${root}/alpha-service","reason":"component","evidence":"the ticket component names it"}]}'`,
    'fi',
  ].join('\n'));
  spawnSync('chmod', ['+x', p]);
  return p;
}

function codelineRoot(): string {
  const root = join(work, 'codelines');
  for (const name of ['alpha-service', 'beta-service']) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\nHandles the ${name} domain for the estate.\n`);
    spawnSync('git', ['-C', dir, 'init', '--quiet']);
  }
  return root;
}

/** Run discovery with its output in a TEMP dir and a real LOG_DIR, as every caller does. */
function runDiscovery(logDir: string) {
  const root = codelineRoot();
  const temp = mkdtempSync(join(work, 'discovery-temp-'));
  const issues = join(work, 'issues.json');
  writeFileSync(issues, JSON.stringify([{
    jiraKey: 'W-1',
    title: 'Alpha rounds the wrong way',
    description: 'The alpha-service rounds a boundary value down instead of up.',
    components: ['alpha-service'],
  }]));

  const r = spawnSync(process.execPath, [
    join(SCRIPTS, 'lib/codeline-discovery.js'),
    '--issues', issues, '--root', root,
    '--out', join(temp, 'codeline-discovery.json'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stubAiRun(root),
      LOG_DIR: logDir,
      EPAM_BROWNFIELD: '1',
    },
  });
  expect(r.status, `discovery exited ${r.status}: ${r.stderr?.slice(-500)}`).toBe(0);
  return { temp };
}

describe('the vocabulary a run derived survives the run', () => {
  it('lands in the run evidence directory, not in the temp dir the caller deletes', () => {
    const logDir = join(work, 'logs');
    mkdirSync(logDir, { recursive: true });
    const { temp } = runDiscovery(logDir);

    // The temp directory is what every caller removes on exit; anything only there is gone.
    rmSync(temp, { recursive: true, force: true });

    expect(existsSync(join(logDir, 'discovery-vocabulary.json')),
      'the applied vocabulary is not in the run evidence — it was written beside the discovery '
      + 'output, which every caller points at a temp directory it deletes, so the only record of '
      + 'which terms chose the repository is destroyed with it',
    ).toBe(true);
  });

  it('records the terms that were APPLIED, not merely that a vocabulary existed', () => {
    const logDir = join(work, 'logs');
    mkdirSync(logDir, { recursive: true });
    runDiscovery(logDir);

    const doc = JSON.parse(readFileSync(join(logDir, 'discovery-vocabulary.json'), 'utf8'));
    expect(doc.derived, 'the record does not say whether a vocabulary was derived at all').toBe(true);
    const asText = JSON.stringify(doc);
    expect(asText, 'the blacklisted term is absent, so the file cannot answer what was filtered')
      .toContain('service');
  });
});
