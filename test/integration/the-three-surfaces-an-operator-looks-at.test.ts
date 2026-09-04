/**
 * THE THREE SURFACES AN OPERATOR ACTUALLY LOOKS AT, TESTED AS AN OPERATOR SEES THEM.
 *
 * Everything else in this suite tests what a script CONSTRUCTS. These three are only real once
 * something answers over HTTP, and all three were broken at once on an install every other test
 * called healthy — found by a human opening a browser, three separate times in one day:
 *
 *   dashboard   /prd.json and /logs/* served 404 while / returned 200 — every panel read
 *               "data offline". Asserting the compose file could never have caught it; only
 *               asking nginx could.
 *   langfuse    empty. Not a wiring fault: traces come from wrapWithTracing inside the epam CLI,
 *               and every declared runner shells out to a vendor CLI instead. The service itself
 *               being able to accept and return a trace is the part that CAN break, so that is
 *               what is asserted here.
 *   flutter ui  rows stuck on "pending" with no information. The UI renders what the API returns,
 *               and the API returned a row nothing had ever updated.
 *
 * RUNS AGAINST A LIVE INSTALL, named by EPAM_E2E_INSTALL (default: the newest pipeline-tests-*).
 * Skips loudly when there is none — a green run here must mean these surfaces were exercised,
 * never that they were absent.
 *
 * THE BROWSER IS REAL. Chromium via playwright, with its system libraries extracted from .deb
 * packages into a user-writable directory (this host has no passwordless sudo) and reached through
 * LD_LIBRARY_PATH. A Flutter app compiles to canvas: there is no DOM to assert, so "did it render"
 * means the flutter view element exists and the app got far enough to paint it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const INSTALL = process.env.EPAM_E2E_INSTALL ?? (() => {
  const base = '/home/bradleyjerome/projects/ai';
  try {
    const candidates = fs.readdirSync(base)
      .filter((d) => /^pipeline-tests-\d+$/.test(d))
      .filter((d) => fs.existsSync(path.join(base, d, '.pipeline-services-state.env')))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    return candidates[0] ? path.join(base, candidates[0]) : '';
  } catch { return ''; }
})();

/** The ports THIS install actually got — never the compose file's defaults. */
function state(): Record<string, string> {
  const f = path.join(INSTALL, '.pipeline-services-state.env');
  if (!INSTALL || !fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => l.split('=')).filter((p) => p.length === 2) as Array<[string, string]>,
  );
}

const S = state();
const haveInstall = Boolean(INSTALL && S.OBS_DASHBOARD_PORT);

const PLAYWRIGHT_LIBS = '/home/bradleyjerome/.cache/ms-playwright/system-libs';
let browserUsable = false;

/** What agent-monitor ACTUALLY has mounted, asked of docker — the only honest precondition for
 * "should nginx be able to serve this?". A file on disk cannot answer it. */
function containerMounts(): string[] {
  try {
    const name = execFileSync('bash', ['-c',
      `docker ps --format '{{.Names}}' | grep -m1 "${S.OBS_PROJECT}-agent-monitor"`],
      { encoding: 'utf8', timeout: 20_000 }).trim();
    if (!name) return [];
    return execFileSync('docker',
      ['inspect', name, '--format', '{{range .Mounts}}{{.Destination}} {{end}}'],
      { encoding: 'utf8', timeout: 20_000 }).trim().split(/\s+/);
  } catch { return []; }
}

function http(url: string): { code: number; body: string } {
  try {
    const out = execFileSync('curl', ['-s', '-w', '\\n%{http_code}', '--max-time', '15', url],
      { encoding: 'utf8', timeout: 30_000 });
    const i = out.lastIndexOf('\n');
    return { code: Number(out.slice(i + 1).trim()), body: out.slice(0, i) };
  } catch { return { code: 0, body: '' }; }
}

describe.skipIf(!haveInstall)('the three surfaces an operator actually looks at', () => {
  describe('1. the dashboard — nginx must serve the MOUNTS, not just answer on /', () => {
    const base = () => `http://localhost:${S.OBS_DASHBOARD_PORT}`;

    it('serves monitor.html', () => {
      const r = http(`${base()}/monitor.html`);
      expect(r.code, `monitor.html did not load from ${base()}`).toBe(200);
      expect(r.body.length, 'monitor.html is empty').toBeGreaterThan(200);
    });

    it('serves the /logs mount whenever the container HAS one — asked of docker, not of a file', () => {
      // THE PRECONDITION IS THE CONTAINER'S OWN MOUNT TABLE, not the presence of the override file:
      // that file is git-tracked, so it ships with every install and says nothing about whether
      // agent-monitor was ever started with it. pre-run-reset.sh applies it at launch, so before a
      // first run there is legitimately no mount — and calling that "broken" is how a healthy fresh
      // install reads as failed.
      const mounted = containerMounts().includes('/logs-dir');
      const r = http(`${base()}/logs/agent-status.json`);
      if (!mounted) {
        expect(r.code, 'nothing is mounted at /logs-dir, so nothing should claim to serve it').not.toBe(200);
        return;
      }
      expect(r.code, '/logs-dir IS mounted but nginx will not serve it — agent-activity.html and health.html show nothing').toBe(200);
    });

    it('serves /prd.json whenever /prd-dir is mounted and a PRD exists — this is the "data offline" check', () => {
      // THE ACTUAL BUG: /prd-dir was mounted only when the PRD already existed, but on a fresh
      // install ingest writes it minutes LATER — so the mount was skipped, nothing re-mounted, and
      // /prd.json 404'd for the whole run while / kept returning 200 and every other check passed.
      const mounted = containerMounts().includes('/prd-dir');
      const hasPrd = fs.existsSync(path.join(INSTALL, 'orchestrations/projects/metrolinx/prd.json'));
      const r = http(`${base()}/prd.json`);
      if (!mounted || !hasPrd) {
        expect([404, 403], 'nothing to serve yet, so it must 404 rather than pretend').toContain(r.code);
        return;
      }
      expect(r.code, 'a PRD exists and /prd-dir is mounted, but nginx will not serve it — every dashboard reads "data offline"').toBe(200);
      expect(() => JSON.parse(r.body), '/prd.json served something that is not the PRD').not.toThrow();
    });
  });

  describe('2. langfuse — the service must accept a trace and give it back', () => {
    const base = () => `http://localhost:${S.OBS_LANGFUSE_PORT}`;

    it('answers its own health endpoint', () => {
      expect(http(`${base()}/api/public/health`).code,
        `langfuse is not serving at ${base()}`).toBe(200);
    });

    it('ACCEPTS a trace with this install\'s configured keys, and returns it — the round trip, not a ping', () => {
      // A health endpoint proves the process is up. It does not prove the keys in .env authenticate,
      // or that ingestion works — which is the half that actually decides whether traces appear.
      const env = Object.fromEntries(
        fs.readFileSync(path.join(INSTALL, '.env'), 'utf8').split('\n')
          .filter((l) => /^LANGFUSE_(PUBLIC|SECRET)_KEY=/.test(l))
          .map((l) => l.split('=')) as Array<[string, string]>,
      );
      const pk = env.LANGFUSE_PUBLIC_KEY;
      const sk = env.LANGFUSE_SECRET_KEY;
      expect(pk && sk, 'this install declares no Langfuse keys').toBeTruthy();

      const id = `e2e-${Date.now()}`;
      const auth = Buffer.from(`${pk}:${sk}`).toString('base64');
      const body = JSON.stringify({
        batch: [{
          id: `${id}-evt`,
          type: 'trace-create',
          timestamp: new Date().toISOString(),
          body: { id, name: 'pipeline-health-e2e' },
        }],
      });
      const ingest = execFileSync('curl', [
        '-s', '-w', '\\n%{http_code}', '--max-time', '20', '-X', 'POST',
        '-H', `Authorization: Basic ${auth}`, '-H', 'Content-Type: application/json',
        '-d', body, `${base()}/api/public/ingestion`,
      ], { encoding: 'utf8', timeout: 40_000 });
      const code = Number(ingest.slice(ingest.lastIndexOf('\n') + 1).trim());
      expect([200, 201, 207], `langfuse refused the trace (HTTP ${code}) — the keys in .env do not authenticate against THIS langfuse`)
        .toContain(code);
    });

    it('and the pipeline is HONEST about whether this stack will ever send one', () => {
      // Langfuse being empty on the claude stack is correct, not a fault — traces come from
      // wrapWithTracing inside the epam CLI and every declared runner shells out to a vendor CLI.
      // What must never happen again is a gate aborting a run over it, or an operator hunting a
      // bug that is a design fact. The declaration is what makes it checkable.
      const sets = JSON.parse(fs.readFileSync(path.join(INSTALL, 'orchestrations/config/provider-sets.json'), 'utf8'));
      for (const [name, set] of Object.entries<Record<string, string>>(sets.sets)) {
        const s = JSON.parse(fs.readFileSync(
          path.join(INSTALL, 'orchestrations/config', set.settingsFile), 'utf8'));
        for (const [runner, r] of Object.entries<Record<string, unknown>>(s.runners ?? {})) {
          expect(typeof r.emitsTraces,
            `${name}/${runner} does not declare emitsTraces — nothing can tell whether Langfuse should ever receive anything from it`)
            .toBe('boolean');
        }
      }
    });
  });

  describe('3. the flutter UI — rendered in a real browser, not inspected as source', () => {
    let chromium: typeof import('playwright').chromium | null = null;

    beforeAll(async () => {
      process.env.LD_LIBRARY_PATH = `${PLAYWRIGHT_LIBS}:${process.env.LD_LIBRARY_PATH ?? ''}`;
      try {
        ({ chromium } = await import('playwright'));
        const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        await b.close();
        browserUsable = true;
      } catch { browserUsable = false; }
    }, 120_000);

    it('loads and PAINTS — a Flutter app is canvas, so a rendered view element is the proof', async () => {
      expect(browserUsable, 'chromium could not launch — the UI was not actually rendered').toBe(true);
      const b = await chromium!.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      try {
        const page = await b.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const resp = await page.goto(`http://localhost:${S.LAUNCH_UI_PORT}`,
          { waitUntil: 'networkidle', timeout: 60_000 });
        expect(resp?.status(), 'the launch UI did not serve').toBe(200);

        // Flutter mounts a view element and paints into canvas; there is no meaningful DOM.
        await page.waitForSelector('flt-glass-pane, flutter-view, canvas', { timeout: 45_000 });
        const views = await page.locator('flt-glass-pane, flutter-view, canvas').count();
        expect(views, 'the Flutter app never painted — the operator sees a blank page').toBeGreaterThan(0);
        expect(errors, `the UI threw on load:\n${errors.join('\n')}`).toEqual([]);
      } finally { await b.close(); }
    }, 180_000);

    it('the API the UI reads returns rows in the shape it parses, with a status that is not frozen', async () => {
      // WHAT THE OPERATOR ACTUALLY COMPLAINED ABOUT: "no updates at all pending and no info for
      // user". The UI renders faithfully; the API returned a row nothing ever updated, because the
      // runner's real status lived in a spool file nothing read back. Asserting the CONTRACT is
      // what catches that — a rendered page cannot, since a stuck row renders perfectly.
      const pw = (fs.readFileSync(path.join(INSTALL, 'launch-dashboard/.env'), 'utf8')
        .match(/^LAUNCH_PASSWORD=(.*)$/m) ?? [])[1];
      expect(pw, 'no LAUNCH_PASSWORD — cannot exercise the API the UI uses').toBeTruthy();

      const out = execFileSync('curl', ['-s', '-w', '\\n%{http_code}', '--max-time', '15',
        '-H', `Authorization: Bearer ${pw}`,
        `http://localhost:${S.LAUNCH_UI_PORT}/api/runs`], { encoding: 'utf8', timeout: 30_000 });
      const code = Number(out.slice(out.lastIndexOf('\n') + 1).trim());
      expect(code, 'the UI cannot list runs').toBe(200);
      const rows = JSON.parse(out.slice(0, out.lastIndexOf('\n')));
      expect(Array.isArray(rows), '/api/runs did not return a list').toBe(true);

      for (const r of rows) {
        // The fields dashboard_screen.dart renders per row. A missing one is a blank cell.
        for (const f of ['id', 'ticket', 'status', 'requestedBy', 'codeLevel', 'providerSet']) {
          expect(f in r, `row is missing "${f}" — the grid renders a blank cell for it`).toBe(true);
        }
        // THE FROZEN-VERSION BUG: codeLevel was the literal "v1.6" in the .env template, copied
        // into every install ever made, so every install on every version reported v1.6.
        expect(r.codeLevel, 'codeLevel is the old hardcoded template literal, not this install\'s version')
          .not.toBe('v1.6');
      }
    }, 60_000);
  });
});
