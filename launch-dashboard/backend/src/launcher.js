/**
 * launcher.js — spawns the pipeline's own launcher. The last inch before real money is spent.
 *
 * THE DEFECT THIS SHAPE PREVENTS (2026-09-02): a launch was issued as
 *
 *     tier3-metrolinx-run.sh EPAM_RESUME_RUN=... EPAM_PROVIDER_SET=claude
 *
 * i.e. as POSITIONAL ARGUMENTS. tier3-*-run.sh reads those from the ENVIRONMENT and ignores argv,
 * so the run started FRESH, brownfield-preflight-reset hard-reset the codeline to develop, and a
 * committed fix was destroyed. Here the environment is passed as an environment, and argv carries
 * only the launcher's own flags.
 *
 * THE ENVIRONMENT IS BUILT, NOT INHERITED. `env` is constructed from a minimal base plus exactly
 * what the caller declared. An ambient EPAM_PROVIDER_SET or API key in the runner's own environment
 * must never reach a launch: an inherited API key outranked the subscription for seven runs before
 * anyone noticed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** The pipeline prints its identity once, and a resume is impossible without it. */
const RUN_ID = /RUN NUMBER:\s*([0-9A-Za-z_-]+)/;
/** The pause banner. Its presence means the run EXITED deliberately, not that it failed. */
const PAUSED = /PAUSED\s*[—-]/i;

/**
 * @param {{script:string, cwd:string, extraEnv?:object, timeoutMs?:number,
 *          onOutput?:(line:string)=>void}} opts
 */
function createLauncher({ script, cwd, extraEnv = {}, timeoutMs = 0, onOutput = null }) {
  return function launch(request, env, argv) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(script)) {
        // A missing launcher must say so. Reported as a mystery failure, it looks like a pipeline
        // defect and gets debugged in the wrong place.
        return reject(new Error(`launcher script not found: ${script}`));
      }

      // Minimal base. PATH and HOME are needed for the launcher to find its tools and credentials;
      // nothing else is inherited, so no ambient provider or key can leak into the run.
      const childEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? 'C.UTF-8',
        ...extraEnv,
        ...env,
      };

      const child = spawn('bash', [script, ...argv], {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      let runId = null;
      let paused = false;
      const absorb = (buf) => {
        const text = String(buf);
        out += text;
        if (!runId) { const m = text.match(RUN_ID); if (m) runId = m[1]; }
        if (!paused && PAUSED.test(text)) paused = true;
        if (onOutput) for (const line of text.split('\n')) if (line) onOutput(line);
      };
      child.stdout.on('data', absorb);
      child.stderr.on('data', absorb);

      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, timeoutMs);
      }

      child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({
          code: code === null ? 143 : code,
          signal,
          runId,
          paused,
          // The tail only — the full output is the pipeline's own log, which is the authority.
          output: out.slice(-8000),
        });
      });
    });
  };
}

export { createLauncher };
