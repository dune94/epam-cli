/**
 * Real headless-browser verification of the Grafana pipeline dashboards —
 * loads each dashboard exactly like a human would (fresh navigation, no
 * client-side route reuse) and asserts no panel shows "No data" combined
 * with an error state, and no panel error icon is present.
 *
 * Why this exists (2026-07-23): repeated manual back-and-forth where curl
 * replays of a panel's exact query against Grafana's /api/ds/query returned
 * real, correct data (status 200), yet the SAME panel rendered "No data"
 * with a red error icon in an actual browser. A backend query replay proves
 * the datasource/backend is fine; it does NOT prove what a browser renders.
 * This test closes that gap by using a real browser instead of asking a
 * human to keep checking screenshots.
 *
 * Requires the observability stack running (docker compose -f
 * docker-compose.observability.yml up -d) and reachable at
 * http://localhost:3001. Skipped automatically if Grafana isn't reachable —
 * this is a real infrastructure dependency, not something to mock.
 *
 * Playwright's bundled Chromium needs libnspr4/libnss3/libnssutil3/libsmime3,
 * which aren't installed system-wide here and `playwright install --with-deps`
 * requires sudo (unavailable, no password). VS Code's snap happens to bundle
 * all four — point LD_LIBRARY_PATH at it to run this file:
 *   LD_LIBRARY_PATH="/snap/code/252/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH" \
 *     ~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run \
 *     test/integration/grafana-dashboards.test.ts
 * (adjust the snap revision number if it differs on the machine running this).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';

const GRAFANA_URL = 'http://localhost:3001';
const AUTH = { username: 'admin', password: 'admin' };

const DASHBOARDS = [
  { uid: 'epam-pipeline-cost', slug: 'pipeline-cost', name: 'Pipeline Cost' },
  { uid: 'epam-pipeline-timeline', slug: 'pipeline-timeline', name: 'Run Timeline' },
  { uid: 'epam-pipeline-status', slug: 'pipeline-status', name: 'Story & Pipeline Status' },
];

async function isGrafanaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${GRAFANA_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// playwright is an OPTIONAL dependency — it is not in package.json (its Chromium
// needs system libs that require sudo here, see the header note). A bare
// `await import('playwright')` is still statically analysed by Vite at transform
// time, so a missing playwright made this whole FILE fail to load ("Failed to
// load url playwright") and turned the mandated `vitest run` red rather than
// skipping cleanly. Indirect the specifier + @vite-ignore so resolution happens
// at runtime, and gate the suite on it the same way we gate on Grafana itself.
async function loadPlaywright(): Promise<typeof import('playwright') | null> {
  try {
    const spec = 'playwright';
    return await import(/* @vite-ignore */ spec);
  } catch {
    return null;
  }
}

let browser: Browser | null = null;
let grafanaUp = false;

beforeAll(async () => {
  grafanaUp = await isGrafanaUp();
  if (!grafanaUp) return;
  const pw = await loadPlaywright();
  if (!pw) return;
  browser = await pw.chromium.launch();
});

// Grafana's dashboard UI uses cookie-based form login, not HTTP Basic Auth
// (that only authenticates the raw /api/* endpoints, e.g. via curl -u) —
// a browser context must actually submit the login form once to get a
// session cookie, then reuse that same context for every dashboard load.
async function loggedInContext() {
  if (!browser) throw new Error('browser not launched');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${GRAFANA_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="user"]', AUTH.username);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  // Grafana forces an "Update your password" prompt whenever the admin
  // account still has the literal default password — skip it, this is a
  // disposable local dev instance, not a real credential to rotate.
  const skipButton = page.getByText('Skip', { exact: true });
  if (await skipButton.isVisible().catch(() => false)) {
    await skipButton.click();
  }
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
  await page.close();
  return context;
}

afterAll(async () => {
  if (browser) await browser.close();
});

async function loadDashboard(page: Page, uid: string, slug: string): Promise<void> {
  await page.goto(
    `${GRAFANA_URL}/d/${uid}/${slug}?orgId=1&from=now-24h&to=now`,
    { waitUntil: 'networkidle' }
  );
  // Panels resolve their queries asynchronously after the shell renders —
  // wait for at least one panel content region to exist, then give queries
  // a moment to settle rather than racing the first paint.
  await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 15000 });
  await page.waitForTimeout(3000);
}

const canRun = (await isGrafanaUp()) && (await loadPlaywright()) !== null;

describe.skipIf(!canRun)('Grafana dashboards — real browser rendering', () => {
  for (const { uid, slug, name } of DASHBOARDS) {
    it(`${name}: no panel shows "No data" combined with an error icon`, async () => {
      if (!browser) throw new Error('Grafana was reachable in beforeAll but browser failed to launch');
      const context = await loggedInContext();
      const page = await context.newPage();
      try {
        await loadDashboard(page, uid, slug);

        const panelTitles = await page.locator('[data-testid^="data-testid Panel header"]').allTextContents();
        expect(panelTitles.length, 'dashboard rendered zero panels').toBeGreaterThan(0);

        // Grafana marks a panel's status button with this exact data-testid
        // whenever its query returned an error — the real signal a human
        // sees as "broken" (a red triangle), distinct from a panel that's
        // legitimately empty (which shows "No data" with a normal, non-error
        // status button, or no status button at all).
        const ERROR_SELECTOR = '[data-testid="data-testid Panel status error"]';
        const errorIcons = await page.locator(ERROR_SELECTOR).count();

        if (errorIcons > 0) {
          // Surface the actual panel titles that errored for a useful failure message
          const erroredPanels: string[] = [];
          const headers = page.locator('[data-testid^="data-testid Panel header"]');
          const count = await headers.count();
          for (let i = 0; i < count; i++) {
            const header = headers.nth(i);
            const hasError = await header.locator(ERROR_SELECTOR).count();
            if (hasError > 0) erroredPanels.push(await header.getAttribute('data-testid') || `panel ${i}`);
          }
          throw new Error(`${erroredPanels.length} panel(s) show a real error icon: ${erroredPanels.join(', ')}`);
        }
      } finally {
        await context.close();
      }
    }, 30000);
  }

  it('each dashboard\'s panels show real content, not "No data" text, when the pipeline has real log data', async () => {
    if (!browser) throw new Error('Grafana was reachable in beforeAll but browser failed to launch');
    // Only meaningful when there's actually data to show — verified separately
    // via the backend API before asserting on browser text, so this doesn't
    // false-fail on a genuinely empty log window.
    const activityRes = await fetch(`${GRAFANA_URL.replace('3001', '8092')}/logs/agent-activity.jsonl`).catch(() => null);
    const hasRealData = !!activityRes && activityRes.ok && (await activityRes.text()).trim().length > 0;
    if (!hasRealData) return; // nothing to assert against right now

    for (const { uid, slug, name } of DASHBOARDS) {
      const context = await loggedInContext();
      const page = await context.newPage();
      try {
        await loadDashboard(page, uid, slug);
        const bodyText = await page.textContent('body');
        const noDataCount = (bodyText?.match(/No data/g) || []).length;
        const panelCount = await page.locator('[data-testid^="data-testid Panel header"]').count();
        expect(noDataCount, `${name}: ${noDataCount}/${panelCount} panels show "No data" despite real log data existing`).toBe(0);
      } finally {
        await context.close();
      }
    }
  }, 60000);
});
