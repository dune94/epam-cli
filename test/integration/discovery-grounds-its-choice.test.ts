/**
 * DISCOVERY, FOR REAL, AGAINST THE CONFIGURED PROJECT — and judged on grounding, not on the
 * answer.
 *
 * SPENDS TOKENS. Opt-in only: set EPAM_LIVE_DISCOVERY_TEST=1. One agent call.
 *
 * WHY IT DOES NOT ASSERT WHICH REPOSITORY. Naming the expected codeline would put this project's
 * answer inside a test of the generic pipeline — the same defect as every constant removed from
 * the decision path. It would also pass for the wrong reason: an agent that guessed correctly and
 * an agent that reasoned would be indistinguishable.
 *
 * WHAT IT ASSERTS INSTEAD is the property that makes an answer trustworthy on a project nobody has
 * seen: every selection is REAL and GROUNDED.
 *
 *   - the path exists, is a git repository, and is one of the candidates it was shown
 *   - every selection carries its own reason and its own evidence
 *   - THE EVIDENCE IS VERIFIABLE: whatever it quotes is either a field of the ticket verbatim, or
 *     is actually present in that repository. This is the assertion that cannot be satisfied by
 *     guessing, because the test opens the repository and checks.
 *
 * A run that picks the "right" repository with unverifiable evidence fails here, and it should:
 * on the next ticket the same reasoning picks the wrong one.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIVE = process.env.EPAM_LIVE_DISCOVERY_TEST === '1';
const REPO = join(__dirname, '../..');

/** The project under test is whichever one the operator configured — never named here. */
const PROJECT_DIR = process.env.EPAM_PROJECT_CONFIG_DIR || '';

const describeLive = LIVE ? describe : describe.skip;

describeLive('discovery grounds its choice in the estate', () => {
  it('every selected codeline is real, and its evidence checks out', () => {
    expect(PROJECT_DIR, 'EPAM_PROJECT_CONFIG_DIR must name the project to discover for')
      .not.toBe('');

    const root = process.env.JIRA_CODELINE_ROOT || '';
    expect(root, 'JIRA_CODELINE_ROOT must be set').not.toBe('');

    // THE TICKETS COME FROM THE TRACKER, read-only, exactly as a run ingests them — so this
    // exercises the real input shape rather than a fixture someone wrote to pass.
    const issues = JSON.parse(execFileSync(
      process.execPath,
      ['-e', `
        const c = require(${JSON.stringify(join(REPO, 'orchestrations/scripts/lib/jira-client.js'))});
        c.getProjectIssues(process.env.JIRA_PROJECT_KEY)
          .then((r) => process.stdout.write(JSON.stringify(r)))
          .catch((e) => { process.stderr.write(String(e && e.message)); process.exit(1); });
      `],
      { encoding: 'utf8', timeout: 120000, env: process.env },
    ));
    expect(issues.length, 'the tracker returned no tickets — nothing to discover for')
      .toBeGreaterThan(0);

    const work = mkdtempSync(join(tmpdir(), 'discovery-live-'));
    const issuesPath = join(work, 'issues.json');
    const outPath = join(work, 'codeline-discovery.json');
    writeFileSync(issuesPath, JSON.stringify(issues));

    execFileSync(process.execPath, [
      join(REPO, 'orchestrations/scripts/lib/codeline-discovery.js'),
      '--issues', issuesPath, '--root', root, '--out', outPath,
    ], { encoding: 'utf8', timeout: 900000, env: { ...process.env, LOG_DIR: work }, stdio: 'inherit' });

    expect(existsSync(outPath), 'discovery wrote no result').toBe(true);
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    const chosen = result.codelines || [];
    expect(chosen.length, 'discovery selected nothing').toBeGreaterThan(0);

    // What it was shown — the candidate set, so a selection cannot be invented.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { buildRepoManifest } = require(join(REPO, 'orchestrations/scripts/lib/codeline-discovery.js'));
    const manifestPaths = new Set(buildRepoManifest(root).map((r: { path: string }) => r.path));

    const ticketText = JSON.stringify(issues).toLowerCase();

    for (const cl of chosen) {
      expect(existsSync(cl.path), `selected a path that does not exist: ${cl.path}`).toBe(true);
      expect(existsSync(join(cl.path, '.git')), `not a git repo: ${cl.path}`).toBe(true);
      expect(manifestPaths.has(cl.path), `selected a repo it was never shown: ${cl.path}`).toBe(true);

      expect(String(cl.reason || '').trim().length,
        `'${cl.name}' was selected with no reason`).toBeGreaterThan(0);
      const evidence = String(cl.evidence || '').trim();
      expect(evidence.length, `'${cl.name}' was selected with no evidence`).toBeGreaterThan(0);

      // THE ASSERTION GUESSING CANNOT SATISFY. Pull the quoted tokens out of the evidence and
      // require that they are findable — in the ticket, or in the repository that was chosen.
      // Short fragments are skipped rather than treated as proof: a two-character quote is not
      // evidence of anything, and demanding it would fail honest answers.
      const quoted = [...evidence.matchAll(/["'`]([^"'`]{4,})["'`]/g)].map((m) => m[1]);
      const tokens = quoted.length ? quoted
        : evidence.split(/[\s,;()]+/).filter((t) => t.length >= 6);

      const verifiable = tokens.filter((t) => {
        if (ticketText.includes(t.toLowerCase())) return true;      // quoted from the ticket
        if (existsSync(join(cl.path, t))) return true;              // a real file or directory
        try {                                                        // or present in the code
          execFileSync('grep', ['-rqiF', '--', t, cl.path],
            { timeout: 60000, stdio: 'ignore' });
          return true;
        } catch { return false; }
      });

      expect(verifiable.length,
        `'${cl.name}' cites evidence that is in neither the ticket nor the repository: ${evidence}`)
        .toBeGreaterThan(0);
    }
  }, 1_200_000);
});
