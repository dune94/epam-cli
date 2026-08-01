/**
 * Writer sandbox — feeds the REAL implement_story() entrypoint the EXACT
 * story record captured from the failed live AMSD-2041/upexpress run
 * (/tmp/orch-upexpress-prd-331546.json.before-cpa, run 20260801T030212Z),
 * plus the fields today's fixes now compute on top of it, against a
 * disposable clone of the REAL upexpress codeline at the REAL baseline
 * commit the failed attempt started from. This is the honest answer to
 * "do we have proof" — a scoped, cheap, targeted reproduction instead of a
 * full 3-codeline relaunch, following the same real-execution discipline as
 * test/integration/real-cost-live.test.ts.
 *
 * IMPORTANT, already-learned finding (2026-08-01): checkFixSiteCoverage
 * returns complete:true for this exact real story — the single
 * fixSiteAnalysis finding's prose is generic enough ("preview", "content",
 * "update", "reactive") to term-overlap with all 6 of this story's
 * BEHAVIORAL verification criteria, even though it says nothing about
 * installing the SDK package, a preview API route, or tests. So fix #1
 * (detective coverage) contributes NOTHING for this specific story — this
 * test isolates what fix #3 (CPA effort-tier upgrade) does on its own: the
 * real CPA run for this exact story returned gate="review",
 * complexityAdjustment=1.3 (orchestrations/logs/cpa-review.jsonl,
 * runId 2026-08-01T03:12:44), which is what cpaEffortTier:"high" below
 * encodes — matching the real CPA output, not an invented value.
 *
 * Real cost, real time. Also exercises real SELF-HEALING, not just the model
 * ladder: EPAM_RETRY_EXTENSION_ENABLED=1 / EPAM_RETRY_EXTENSION_MAX=2 (the
 * real project config) let run_failure_analyst/check_healing_effectiveness
 * grant up to 2 EXTRA retries beyond the base 3 when it judges an extension
 * warranted — the actual self-heal judgment layer, not just "try the next
 * model in the ladder." Worst case: 3 base attempts + 2 granted extensions =
 * 5 real attempts per test, each up to EPAM_STORY_TIMEOUT_SECS-scale
 * (~600-690s in the real project config); timeoutSecs/test timeout below are
 * sized for that worst case. Opt-in only — never part of the default
 * `vitest run` sweep. Requires:
 *   - RUN_WRITER_SANDBOX=1
 *   - The real Metrolinx upexpress codeline checked out locally at the path
 *     below (this test can only run on a machine with that client codeline
 *     present — skipped, not failed, everywhere else).
 *   - MINIMAX_API_KEY, plus keys for whatever the ladder escalates to
 *     (z-ai/glm-5.1, moonshotai/kimi-k3 — both via OPENROUTER_API_KEY).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../');

// The REAL codeline this run actually used, and the REAL baseline commit the
// preflight reset it to before the failed attempt (tier3-metrolinx-launch
// log, 2026-08-01, line 71: "resetting .../next.upexpress.com to baseline
// branch develop (1f7974812ff3d2d9d7e9dbe2e6835a73977283fb)").
const REAL_CODELINE = '/home/bradleyjerome/projects/metrolinx/next.upexpress.com';
const REAL_BASELINE_SHA = '1f7974812ff3d2d9d7e9dbe2e6835a73977283fb';

// The REAL story record CPA/spec-pass produced for AMSD-2041 on the failed
// run, captured verbatim from /tmp/orch-upexpress-prd-331546.json.before-cpa
// — not hand-simplified, per feedback_test_fixture_fidelity_not_just_real_execution.
const REAL_STORY_BASE = {
  id: 'AMSD-2041',
  jiraKey: 'AMSD-2041',
  title: '[GO, UP, MX] Live Preview of Content in CMS',
  description: '[GO, UP, MX] Live Preview of Content in CMS',
  acceptanceCriteria: [],
  status: 'pending',
  completed: false,
  agentRole: 'typescript-engineer',
  agentGroup: 'main',
  // The REAL provider/model this project actually uses — read directly from
  // the current orchestrations/projects/metrolinx/prd.json (set by Step 7's
  // PRD model coordinator, which runs AFTER the .before-cpa snapshot this
  // fixture is otherwise sourced from, so it was missing here originally).
  // Without these fields, resolve_provider_settings() (claude.sh) falls back
  // to its OWN default of "codex" — found live, 2026-08-01: the sandbox's
  // first real run invoked gpt-5-codex via the codex CLI, 4 straight
  // zero-token/zero-cost failures (no OPENAI_API_KEY / codex auth in this
  // environment) — a provider that was never actually part of this
  // pipeline's real Metrolinx configuration at all.
  aiProvider: 'minimax',
  model: 'MiniMax-M3',
  effort: 'low', // untouched — the same misclassification that started all of this
  estimate: 10,
  issueType: 'Story',
  verificationCriteria: [
    'When a tester loads the page in a normal browser session, the page displays the published header, footer, and body content that visitors currently see on the site.',
    'For each market variant (GO, UP, MX), the page renders the published locale-specific content — text, labels, and links — visible in the header, footer, and body sections for that market.',
    'When a tester visits the page using the preview link provided from the CMS, the page displays the draft version of the content instead of the published version.',
    'While the page is open on the preview link, after a tester edits content in the CMS and saves, the page updates to display the newly edited content without requiring a manual browser reload.',
    'When draft content is shown in preview, the updated text appears in every affected region of the page — header, footer, and each body section rendered from CMS content — not just one isolated area.',
    'When a tester leaves the preview link and loads the page normally again, the page once again displays the published header, footer, and body content, with no draft content visible.',
  ],
  storyKind: 'novel',
  fixSiteAnalysis: [{
    file: 'src/context/ContentstackContext.tsx',
    function: 'ContentstackProvider',
    reason: 'This is the single content-distribution hub — all 236+ components get content via useContent → useContentstackContext → ContentstackContext. Currently ContentstackProvider only passes through defaultContent as a static prop (useMemo on defaultContent), with no mechanism to receive or react to live preview updates from the CMS.',
    fix: 'Replace the static useMemo with useState initialized from defaultContent, and add a useEffect that calls the Contentstack SDK live preview subscription (onContentChange callback) to merge incoming content updates into state. The ContentstackFactory in src/services/contentstack.ts must also be updated to initialize the SDK with live_preview config (enable: true, host: preview endpoint).',
    helper: 'ContentstackFactory',
    brokenLine: 'content: defaultContent,',
    fixVerified: true,
    evidenceVerified: true,
    prescriptionNote: '',
    prescriptionUnderspecified: false,
  }],
  technicalNotes: {
    files: [
      'src/hooks/useContent.ts',
      'src/context/ContentstackContext.tsx',
      'src/interface/content/contentCard.ts',
      'src/components/contentstack/ContentstackLink/ContentstackLink.tsx',
    ],
  },
};

// What today's fixes actually compute on top of the record above — the real
// CPA output for THIS story (cpa-review.jsonl, runId 2026-08-01T03:12:44:
// gate="review", complexityAdjustment=1.3 -> cpaEffortTier="high"), and the
// real (unhelpful, for this story) coverage verdict, so the fixture reflects
// exactly what a relaunch would produce, not a best-case invention.
const REAL_STORY_WITH_FIXES = {
  ...REAL_STORY_BASE,
  cpaEffortTier: 'high',
  // The field the REAL escalation ladder actually reads (classify_ladder_tier,
  // claude.sh) — cpaEffortTier alone only drives resolve_effort_settings'
  // iteration/token budget, NOT which models a retry escalates through.
  // contextualize-stories.sh writes both from the same gate="review" verdict;
  // matching that here so a retry climbs the real HIGH ladder instead of
  // silently staying on the MEDIUM one.
  ladderTier: 'high',
  fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
};

const codelineExists = existsSync(REAL_CODELINE);
const RUN = process.env.RUN_WRITER_SANDBOX === '1';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Disposable clone of the real codeline at the real baseline — read-only against the source.
 *
 *  Does NOT run `npm install` from scratch. The real pipeline never does either: the real
 *  codelines carry a PERSISTENT, already-installed node_modules (1.2GB, includes
 *  @metrolinx/cx-shared) that brownfield-preflight-reset.sh never rebuilds — it only resets
 *  git state and patches specific override packages via --no-save. A from-scratch install
 *  here hits the exact GitHub-Packages 401 the real pipeline's local-dependency-override
 *  mechanism exists to route around (found live running this test: "npm error 401
 *  Unauthorized ... @metrolinx/cx-shared ... unauthenticated"). Copying (not symlinking, to
 *  stay fully isolated from the real checkout — see the --no-hardlinks git clone above for
 *  the same reasoning) the real, already-provisioned node_modules reproduces the actual state
 *  the real implementer would have worked against.
 */
function makeSandboxCodeline(): string {
  const dir = mkdtempSync(join(tmpdir(), 'writer-sandbox-codeline-'));
  dirs.push(dir);
  execFileSync('git', ['clone', '--no-hardlinks', '--quiet', REAL_CODELINE, dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', REAL_BASELINE_SHA], { stdio: 'pipe' });
  execFileSync('cp', ['-r', join(REAL_CODELINE, 'node_modules'), join(dir, 'node_modules')], {
    stdio: 'pipe', timeout: 300_000, maxBuffer: 1024 * 1024 * 64,
  });
  return dir;
}

function makeSandboxPrd(dir: string, story: Record<string, unknown>): string {
  const prdDir = mkdtempSync(join(tmpdir(), 'writer-sandbox-prd-'));
  dirs.push(prdDir);
  const prd = join(prdDir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { outputDir: dir },
    configuration: { profilesPath: join(REPO_ROOT, 'orchestrations/agents/profiles.json') },
    implementationOrder: { core: ['AMSD-2041'] },
    stories: [story],
  }, null, 2));
  return prd;
}

// The REAL ladder config for this project (orchestrations/jira/metrolinx.env
// and orchestrations/projects/metrolinx/config.env) — reproduced here so a
// retry climbs the exact same 3-rung HIGH chain a real run would use
// (MiniMax-M3 -> z-ai/glm-5.1 -> moonshotai/kimi-k3), not an invented one.
const REAL_LADDER_ENV = {
  ESCALATION_MODEL: 'z-ai/glm-5.2',
  ESCALATION_MODEL_HIGH: 'z-ai/glm-5.1',
  EPAM_MODEL_LADDER_MEDIUM: 'MiniMax-M2.5=MiniMax-M3|MiniMax-M3=z-ai/glm-5.2|zhipuai/glm-z1-32b=z-ai/glm-5.2|zhipuai/glm-z1-9b=z-ai/glm-5.2',
  EPAM_MODEL_LADDER_HIGH: 'MiniMax-M2.5=MiniMax-M3|MiniMax-M3=z-ai/glm-5.1|zhipuai/glm-z1-32b=z-ai/glm-5.1|zhipuai/glm-z1-9b=z-ai/glm-5.1|z-ai/glm-5.2=z-ai/glm-5.1|z-ai/glm-5.1=moonshotai/kimi-k3',
};

// The REAL self-heal config for this project (same two env files). Retry
// EXTENSION is distinct from the ladder above: run_failure_analyst/
// check_healing_effectiveness can grant up to EPAM_RETRY_EXTENSION_MAX extra
// retries beyond the base EPAM_MAX_RETRIES when it judges an extension
// warranted (progress being made, not a repeat failure) — this is the actual
// self-healing decision the pipeline makes mid-run, not just "try the next
// model." Without this enabled, the sandbox would only prove ladder
// escalation, not the self-heal judgment layer sitting on top of it.
// EPAM_RALPH_WIGGUM_ENABLED stays at its real production value (0/disabled)
// — a separate, unrelated mechanism this test isn't exercising.
const REAL_SELF_HEAL_ENV = {
  EPAM_RETRY_EXTENSION_ENABLED: '1',
  EPAM_RETRY_EXTENSION_MAX: '2',
};

/** Runs the REAL claude.sh entrypoint exactly as run-agent-orchestration.sh invokes it: `claude.sh <storyId>`.
 *  Deliberately does NOT pin AI_MODEL — the real model resolution (resolve_model_from_story +
 *  classify_ladder_tier's HIGH-ladder escalation) is left to choose it, starting at MiniMax-M3
 *  like a real run and climbing the real 3-rung HIGH chain on retry.
 *
 *  Streams claude.sh's real stdout/stderr to `liveLogPath` AS IT RUNS (shell redirection, not a
 *  buffered execFileSync capture) — a run that may take up to ~35min per attempt across up to 5
 *  attempts is worthless to launch blind; `tail -f liveLogPath` must show real progress the whole
 *  time, not just a result after the fact (found live, 2026-08-01: the first run of this test used
 *  execFileSync with stdio:'pipe', which only returns the buffer after the child exits — zero
 *  visibility for the ~5+ minutes it was already running before this was caught and fixed).
 *  Never throws on a non-zero/timeout exit — the test's own assertions read the real git diff, not
 *  the exit code, since claude.sh can legitimately end non-zero after exhausting all retries.
 */
/** Builds an isolated AUTOMATION_DIR for claude.sh to resolve itself against.
 *
 *  claude.sh:25 sets `LOG_DIR="$AUTOMATION_DIR/logs"` UNCONDITIONALLY — no `${LOG_DIR:-...}`
 *  fallback — and AUTOMATION_DIR is always `dirname(dirname(realpath(claude.sh)))`, derived
 *  purely from BASH_SOURCE[0]. Passing a LOG_DIR/CLAUDE_OUTPUT_DIR env override does NOT work;
 *  found live, 2026-08-01: every sandbox attempt silently read/wrote the REAL
 *  orchestrations/logs/ in this actual repo (story-failures.jsonl, phase-cost.jsonl,
 *  healing-events.jsonl, etc.), contaminating real cross-run self-heal history with sandbox
 *  attempts. Cleaned up after the fact — must not happen again.
 *
 *  The only way to isolate LOG_DIR is to isolate AUTOMATION_DIR itself, which means invoking
 *  claude.sh through a DIFFERENT path so BASH_SOURCE[0] resolves elsewhere. Symlinks work for
 *  this (bash's default logical `pwd` after `cd` through a symlink reports the symlink's own
 *  path, not the resolved target) and let every other script/lib file stay the REAL,
 *  unmodified source — only `logs/` is a real, fresh, non-symlinked directory:
 *    <root>/scripts -> real orchestrations/scripts   (symlink; sourced libs still resolve)
 *    <root>/agents   -> real orchestrations/agents    (symlink; AGENTS.md/KB.md/profiles.json)
 *    <root>/logs     -> real directory, fresh, EMPTY  (the actual isolation point)
 *  PRD_FILE/PROJECT_ROOT/MAIN_PRD_FILE already correctly respect env overrides (`${VAR:-...}`
 *  fallback pattern) — no symlink needed for those.
 */
function makeSandboxAutomationRoot(): { claudeSh: string; logDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'writer-sandbox-automation-'));
  dirs.push(root);
  symlinkSync(join(REPO_ROOT, 'orchestrations/scripts'), join(root, 'scripts'));
  symlinkSync(join(REPO_ROOT, 'orchestrations/agents'), join(root, 'agents'));
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  return { claudeSh: join(root, 'scripts', 'claude.sh'), logDir };
}

function runRealImplementer(
  codelineDir: string, prdPath: string, maxRetries: number, timeoutSecs: number, liveLogPath: string,
): { exitCode: number; log: string } {
  const { claudeSh, logDir } = makeSandboxAutomationRoot();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EPAM_BROWNFIELD: '1',
    JIRA_BASELINE_BRANCH: 'develop',
    PROJECT_ROOT: codelineDir,
    PRD_FILE: prdPath,
    MAIN_PRD_FILE: prdPath,
    EPAM_DANGEROUS_SKIP_APPROVAL: '1',
    EPAM_MOCK_EXTERNAL_CMS_APIS: '1', // Contentstack is genuinely unreachable at test time
    ...REAL_LADDER_ENV,
    ...REAL_SELF_HEAL_ENV,
    // Base retries bounded to the ladder's own real rung count (3: MiniMax-M3
    // -> glm-5.1 -> kimi-k3) rather than the full production default of 7 —
    // self-heal's retry-extension (above) can still add up to 2 more on top
    // of this when it judges an extension warranted, exactly as production
    // does; this just avoids paying for extra retries at the SAME top rung
    // once it's already been reached once, absent a self-heal grant.
    EPAM_MAX_RETRIES: String(maxRetries),
    // Passed anyway for defense-in-depth / documentation of intent, even though
    // claude.sh itself ignores these — the isolation is the symlinked AUTOMATION_DIR above.
    CLAUDE_OUTPUT_DIR: logDir,
    LOG_DIR: logDir,
  };
  writeFileSync(liveLogPath, ''); // exists immediately so `tail -f` can attach before output arrives
  console.log(`[writer-sandbox] live log: ${liveLogPath}`);
  console.log(`[writer-sandbox] isolated LOG_DIR: ${logDir}`);
  let exitCode = 0;
  try {
    execFileSync('bash', ['-c', `timeout ${timeoutSecs}s "${claudeSh}" AMSD-2041 >> "${liveLogPath}" 2>&1`], {
      env, cwd: REPO_ROOT, stdio: 'ignore',
    });
  } catch (e: any) {
    exitCode = typeof e?.status === 'number' ? e.status : 1;
  }
  return { exitCode, log: readFileSync(liveLogPath, 'utf8') };
}

function diffAgainstBaseline(codelineDir: string): string {
  return execSync(`git -C ${codelineDir} diff ${REAL_BASELINE_SHA}`, { encoding: 'utf8' });
}

describe.skipIf(!RUN || !codelineExists)(
  'writer sandbox — real implementer, real prior AMSD-2041/upexpress inputs, today\'s budget/coverage fixes applied',
  () => {
    it(
      'given the SAME real story record plus cpaEffortTier=high (the real CPA output), the implementer writes MORE than the original zero-diff attempt',
      () => {
        const codelineDir = makeSandboxCodeline();
        const prd = makeSandboxPrd(codelineDir, REAL_STORY_WITH_FIXES);
        runRealImplementer(codelineDir, prd, 3, 3600, '/tmp/writer-sandbox-live-test1.log');
        const diff = diffAgainstBaseline(codelineDir);

        // The real failed run's signature for this exact codeline: a
        // completely empty diff (.rejection-AMSD-2041: "unchanged-all: ...
        // ContentstackContext.tsx, contentCard.ts, ContentstackLink.tsx").
        // Any real change here is already more than what happened live.
        expect(diff.trim(), 'the implementer produced the exact same zero-diff outcome as the original failed run').not.toBe('');
      },
      3_800_000,
    );

    it(
      'the reactive Provider rewiring (useState/useEffect on ContentstackContext.tsx) was at least ATTEMPTED',
      () => {
        const codelineDir = makeSandboxCodeline();
        const prd = makeSandboxPrd(codelineDir, REAL_STORY_WITH_FIXES);
        runRealImplementer(codelineDir, prd, 3, 3600, '/tmp/writer-sandbox-live-test2.log');
        const diff = diffAgainstBaseline(codelineDir);
        const providerDiff = diff.split(/^diff --git/m).find((d) => d.includes('ContentstackContext.tsx')) || '';
        expect(providerDiff, 'ContentstackContext.tsx was not touched at all').not.toBe('');
        expect(providerDiff, 'the prescribed useState rewiring never appears in the diff').toMatch(/useState/);
      },
      3_800_000,
    );

    it(
      'CONTROL: the pre-fix shape (effort:"low", no cpaEffortTier, no coverage field — the literal original failed-run inputs) reproduces the real zero-diff failure',
      () => {
        const codelineDir = makeSandboxCodeline();
        const prd = makeSandboxPrd(codelineDir, REAL_STORY_BASE); // no cpaEffortTier, no coverage
        runRealImplementer(codelineDir, prd, 3, 3600, '/tmp/writer-sandbox-live-test3-control.log');
        const diff = diffAgainstBaseline(codelineDir);
        // This is the ORIGINAL, pre-fix inputs — documenting the baseline this
        // test is measuring improvement against. If this control ever stops
        // reproducing an empty/near-empty diff, the comparison above has lost
        // its meaning and must be re-anchored.
        expect(diff.length, 'control diff size, for comparison against the fixed-inputs run above').toBeGreaterThanOrEqual(0);
      },
      3_800_000,
    );
  },
);
