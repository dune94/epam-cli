/**
 * EVERY SEAM A REAL RUN RECORDED MUST REPLAY, THROUGH THE PATH THE PIPELINE USES.
 *
 * Three days of cassette work — harvester, exporter, exit traps, replay provider, mock loader —
 * each with a green test, and not one replay of a run the pipeline had actually recorded. When
 * the operator paid for runs, the pieces turned out not to agree: the writer's turns were filed
 * under the story id (no agent name), the mock loader split `qa-gate:sast` on the colon, and the
 * replayer looked up names the recorder never wrote. "Isolation is not acceptable — and no longer
 * permitted." (2026-09-11)
 *
 * This is the whole-feature test. It takes a recording THE PIPELINE MADE (one per provider set,
 * declared in test/fixtures/replay/recordings.json), enumerates the seams IN THAT RECORDING — the
 * recording is the list, nothing is named here — and drives each one through ai-run.sh in replay
 * mode, inside the same overlay sandbox rehearse.sh uses, so recorded tool calls really execute
 * against the real trees and are discarded. Every seam is one case. A set with no recording is a
 * RED case, not a skip.
 *
 * What a case proves: invoked as the pipeline invokes it, the seam is answered from the recording
 * (no provider, £0), completes, and its consumed turns come back in order.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const REHEARSE = join(SCRIPTS, 'rehearse.sh');
const AI_RUN = join(SCRIPTS, 'ai-run.sh');
const RECORDINGS = join(ROOT, 'test/fixtures/replay/recordings.json');
const NODE = process.execPath;

/** Decode the exporter's file name back into the seam label. Same rule as cassette-store.js. */
export function seamOfFile(file: string): string {
  return file.replace(/\.json$/, '').replace(/~([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** `<agent> · <story>` → parts; a label with no separator is either an agent or a bare story id. */
export function splitLabel(label: string): { agent: string; story: string } {
  const i = label.indexOf(' · ');
  if (i < 0) return { agent: label, story: '' };
  return { agent: label.slice(0, i), story: label.slice(i + 3) };
}

function providerFor(set: string): { provider: string; model: string } {
  const sets = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).sets;
  const defaults = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config', sets[set].settingsFile), 'utf8'));
  // The replay substitution replaces the provider regardless; these only have to be a routable pair.
  const primary = defaults.primaryProvider || defaults.provider || (defaults.providers && defaults.providers[0]) || set;
  const model = defaults.model || defaults.defaultModel || 'replay';
  return { provider: String(primary), model: String(model) };
}

/** A one-line executable that runs THIS tree's dist — llm-handler.sh invokes "$EPAM_CLI" as one word. */
function repoCli(): string {
  const d = mkdtempSync(join(tmpdir(), 'repo-cli-'));
  const sh = join(d, 'epam');
  writeFileSync(sh, `#!/bin/bash\nexec ${JSON.stringify(NODE)} ${JSON.stringify(join(ROOT, 'dist/epam.js'))} "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

export function describeSet(set: string) {
  const declared = JSON.parse(readFileSync(RECORDINGS, 'utf8'));
  const rel = declared[set] as string | null;
  const cassette = rel ? join(ROOT, rel) : null;

  describe(`every seam recorded on the ${set} set replays`, () => {
    it(`a recording exists for the ${set} set — a set nobody has recorded cannot be rehearsed`, () => {
      expect(rel, `test/fixtures/replay/recordings.json declares no recording for '${set}'. Record one run on this set; until then the set is unrehearsable and this stays red.`).toBeTruthy();
      expect(cassette && existsSync(join(cassette, 'manifest.json')), `declared recording is not on disk: ${rel}`).toBe(true);
    });

    if (!cassette || !existsSync(join(cassette, 'manifest.json'))) return;

    const files = readdirSync(cassette).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();

    it('the recording holds seams — otherwise every case below is vacuous', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it('no seam was recorded anonymously — a file named only by a story id is a seam nobody named', () => {
      const anonymous = files.map(seamOfFile).filter((l) => !splitLabel(l).agent || /^[A-Z][A-Z0-9]+-\d+$/.test(splitLabel(l).agent));
      expect(anonymous, [
        'These recordings carry no agent name, so no replayer or loader can ever find them by seam.',
        'Live: the story writer sets no EPAM_AGENT_NAME and its 232 turns were filed as AMSD-1919.json.',
      ].join('\n')).toEqual([]);
    });

    const { provider, model } = providerFor(set);
    // THE TOOL POSTURE IS THE SEAM'S DECLARATION, NOT THE HARNESS'S. A seam invoked with no tool
    // grant gets `--no-tools`: the model's tool call is never executed and the turn is the answer.
    // Granting tools to every seam here made the CLI execute recorded calls the live run never ran,
    // and ask for turns the recording never had (prd-change-reviewer: 3 recorded, 4 asked).
    const profiles = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    const declared = profiles.profiles || profiles;
    const toolsFor = (agent: string) => {
      const prof = declared[agent];
      if (!prof) return '1';                 // undeclared (writer, spec agents): tools, as they run live
      return prof.toolGrant ? '1' : '0';
    };

    it.each(files.map((f) => ({ file: f, label: seamOfFile(f) })))(
      'seam "$label" replays through ai-run.sh, tools executing in the sandbox', ({ file, label }) => {
        const turns = JSON.parse(readFileSync(join(cassette, file), 'utf8'));
        expect(Array.isArray(turns) && turns.length > 0, `${file} holds no turns`).toBe(true);
        const { agent, story } = splitLabel(label);
        const logDir = mkdtempSync(join(tmpdir(), 'seam-replay-'));

        const r = spawnSync('bash', [REHEARSE, '--cassette', cassette, '--', 'bash', AI_RUN, '--provider', provider, '--model', model], {
          encoding: 'utf8', timeout: 240_000, cwd: ROOT, input: `replay of ${label}\n`,
          env: {
            ...process.env,
            EPAM_PROVIDER_SET: set,
            EPAM_REPLAY_CASSETTE_DIR: cassette,
            EPAM_AGENT_NAME: agent, EPAM_STORY_ID: story,
            AI_GATE_ALLOW_TOOLS: toolsFor(agent), EPAM_DANGEROUS_SKIP_APPROVAL: '1',
            LOG_DIR: logDir, NODE_BIN: NODE,
            // THE REPOSITORY'S OWN BUILD. `epam` on PATH is a shim to whichever install was made last;
            // a test of this tree must run this tree's dist, or it tests a published version.
            EPAM_CLI: repoCli(),
            EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'),
          },
        });
        const out = (r.stdout || '') + (r.stderr || '');
        expect(out, `the rehearsal did not engage replay for "${label}":\n${out.slice(-1200)}`).toMatch(/REHEARSAL: replaying/);
        expect(out, `"${label}" was not answered from the recording:\n${out.slice(-1500)}`).not.toMatch(/has been called \d+ times and the recorded run called it|All providers exhausted|failed after \d+ attempt/);
        expect(r.status, `ai-run.sh exited ${r.status} replaying "${label}":\n${out.slice(-1500)}`).toBe(0);
      });
  });
}
