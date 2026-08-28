/**
 * NO PROMPT MAY CARRY A CLIENT VALUE. Not in an example, not in a template, not once.
 *
 * A run is stopped for ANY hardcoding in ANY prompt, so this checks every prompt-bearing
 * file the pipeline can send to a model — engine scripts, libraries, plugins, and the agent
 * profiles that ARE prompts.
 *
 * WHAT THIS CAUGHT
 * ----------------
 * codeline-discovery.js's output-format example shipped two real client values to the model
 * on every discovery call:
 *
 *     { "name": "cdts", ... "evidence": "ticket component \"GO\"" }
 *
 * "cdts" is a real repository in one estate; "GO" is a real product area. Every other field
 * in that same example was a proper placeholder ("/absolute/path/to/repo", "what part of
 * the ticket this repo covers"), and the identifier rule three lines above used a correct
 * generic placeholder ("alpha-beta-gamma"). So the file demonstrably knew the pattern and
 * broke it anyway — which is precisely why this needs a test rather than care.
 *
 * Pointed at a different client, that prompt shows the model ANOTHER client's codeline name
 * and product area as the worked example of a correct answer.
 *
 * WHAT IS NOT A VIOLATION
 * -----------------------
 * Runtime data interpolated into a prompt (the ticket, the repo manifest, codeline facts)
 * is the whole point of the prompt and is not hardcoding. This test reads SOURCE, so only
 * literals baked into the file can trip it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { templateBody } from '../../helpers/prompt-text';

const ROOT = join(__dirname, '../../../');

/** Tracked, prompt-bearing engine files. Per-project launchers legitimately name their own project. */
function promptFiles(): string[] {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  return tracked.filter((f) =>
    (f.startsWith('orchestrations/scripts/') || f.startsWith('orchestrations/plugins/') || f.startsWith('src/'))
    && /\.(js|ts|sh)$/.test(f)
    && !/\.test\.|\.spec\./.test(f)
    && !/tier\d+-[a-z0-9-]+-run\.sh$/.test(f)
    && !/mock\d*-[a-z-]*run\.sh$/.test(f));
}

/**
 * Client-identity vocabulary, DERIVED from the projects this repo carries rather than
 * written down — a hardcoded list of client names inside the test would be the very defect
 * it reports. Project directory names and the codelines/components their configs declare
 * are the vocabulary that must never appear in engine source.
 */
function clientVocabulary(): string[] {
  const terms = new Set<string>();
  const projDir = join(ROOT, 'orchestrations/projects');
  for (const p of readdirSync(projDir)) {
    if (!statSync(join(projDir, p)).isDirectory()) continue;
    terms.add(p.toLowerCase());
    const cfg = join(projDir, p, 'config.env');
    try {
      const txt = readFileSync(cfg, 'utf8');
      const root = (txt.match(/^JIRA_CODELINE_ROOT=(.*)$/m) || [])[1];
      if (root) {
        // Every GIT REPOSITORY under the client's codeline root is client vocabulary —
        // that is exactly the set discovery adjudicates, and the set an example might be
        // tempted to draw a name from. Restricted to real repos: a stray file under the
        // root is not a codeline, and treating one as vocabulary produces false positives
        // on ordinary engine identifiers.
        for (const d of readdirSync(root.trim(), { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          try { statSync(join(root.trim(), d.name, '.git')); } catch { continue; }
          const base = d.name.toLowerCase()
            .replace(/^(azure|next|api|react|secure)\./, '')
            .replace(/\.com$/, '')
            .replace(/[^a-z0-9]/g, '');
          if (base.length >= 4) terms.add(base);
        }
      }
      const key = (txt.match(/^JIRA_PROJECT_KEY=(.*)$/m) || [])[1];
      if (key && key.trim().length >= 3) terms.add(key.trim().toLowerCase());
    } catch { /* a project without a readable config contributes nothing */ }
  }
  return [...terms].filter((t) => t.length >= 4);
}

const FILES = promptFiles();
const VOCAB = clientVocabulary();

describe('no engine prompt carries a client value', () => {
  it('derives a real client vocabulary to check against', () => {
    expect(VOCAB.length, 'nothing to check — the derivation found no client terms').toBeGreaterThan(0);
  });

  it('finds prompt-bearing engine files', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('NO client name, codeline, or project key appears in engine source', () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        // Comments narrate incident history; a client name in a post-mortem is
        // documentation, not a value sent to a model.
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) return;
        for (const term of VOCAB) {
          if (new RegExp(`\\b${term}\\b`, 'i').test(line)) {
            offenders.push(`${rel}:${i + 1}: ${t.slice(0, 120)}  [${term}]`);
            break;
          }
        }
      });
    }
    expect(
      offenders,
      'a client value is baked into engine source. Pointed at another client, the prompt ' +
        'shows the model a different client\'s vocabulary as the worked example of a correct answer.',
    ).toEqual([]);
  });
});

describe('agent profiles are prompts too', () => {
  // THE CANONICAL FILES, not the one a run rewrites.
  //
  // profiles.json is REGENERATED every run when agents are minted for the project in hand, so after
  // a metrolinx run it names metrolinx — which is the mechanism working, not a leak. Checking it
  // asserted that engine source carries no client vocabulary while looking at a file that is run
  // state by design, so the only way to make it pass would have been to sanitise a run's output.
  //
  // profiles.json.original is the restore source and IS what ships; it is clean, and it is what
  // this claim is about.
  const files = ['profiles.json.original', 'profiles.canonical.json'];
  for (const f of files) {
    it(`${f} names no client value`, () => {
      const profiles = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents', f), 'utf8'));
      const offenders: string[] = [];
      for (const [agent, prompt] of Object.entries(profiles)) {
        if (typeof prompt !== 'string') continue;
        for (const term of VOCAB) {
          if (new RegExp(`\\b${term}\\b`, 'i').test(prompt)) offenders.push(`${agent} [${term}]`);
        }
      }
      expect(offenders, `${f} sends client vocabulary to a model`).toEqual([]);
    });
  }
  it('and profiles.json is the RUN-mutated copy, not the source of truth', () => {
    // Without this the exclusion above reads as an exemption. The restore source and the live file
    // must actually differ in this respect, or the reasoning for skipping one of them is wrong.
    const live = readFileSync(join(ROOT, 'orchestrations/agents/profiles.json'), 'utf8');
    const canonical = readFileSync(join(ROOT, 'orchestrations/agents/profiles.json.original'), 'utf8');
    expect(live, 'the live file is identical to the restore source — then it is not run state')
      .not.toBe(canonical);
  });
});

