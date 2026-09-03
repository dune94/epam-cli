/**
 * runner-args.js — a spooled request becomes a launch. ONE place, asserted.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, from 2026-09-02:
 *
 *   A launch was issued as
 *       tier3-metrolinx-run.sh EPAM_RESUME_RUN=... EPAM_PROVIDER_SET=claude ...
 *   i.e. as POSITIONAL ARGUMENTS. The launcher reads those from the ENVIRONMENT and ignores argv
 *   (its own usage line says `source .env && bash tier3-metrolinx-run.sh [--yes]`). So the run
 *   started FRESH with no resume, brownfield-preflight-reset hard-reset the codeline to develop,
 *   and a committed fix was destroyed. It survived only via the reflog.
 *
 * The lesson is not "be careful with argv". It is that the environment a launch receives must not
 * be assembled by hand at a call site. It is built here and tested, so a caller cannot get it wrong.
 */

/** Variables the pipeline reads from the ENVIRONMENT. Never argv. */
function buildLaunchEnv(request, { providerSet, retryExtension = true } = {}) {
  if (!request || !request.ticket || !String(request.ticket).trim()) {
    throw new Error('a launch needs a ticket id');
  }
  // NO VENDOR DEFAULT, EVER. A guessed provider is how MiniMax reached a claude run. If nothing
  // declares one, fail loudly rather than choosing on the operator's behalf.
  if (!providerSet || !String(providerSet).trim()) {
    throw new Error('no provider set declared for this launch — refusing to guess a vendor');
  }

  const env = {
    EPAM_PROVIDER_SET: String(providerSet),
    // Standing operator rule: retry extension is always on.
    EPAM_RETRY_EXTENSION_ENABLED: retryExtension ? '1' : '0',
  };

  // The pauses are the human-in-the-loop points. Absent means absent — never "0", because the
  // pipeline tests these with is_truthy and an explicit 0 reads no differently, but an absent
  // variable is honest about not being asked for.
  if (request.pauseAfterMint) env.EPAM_PAUSE_AFTER_AGENT_MINT = '1';
  if (request.pauseBeforeWriter) env.EPAM_PAUSE_BEFORE_WRITER = '1';

  // A RESUME AND A REPLAY ARE NOT THE SAME THING. Only a resume continues a checkpoint; a replay
  // reproduces from the start and must never carry this, or it would silently continue the original.
  if (request.resumeRunId) env.EPAM_RESUME_RUN = String(request.resumeRunId);

  return env;
}

/**
 * argv carries the launcher's own flags and nothing else.
 *
 * `--yes` is not optional under a runner: tier3-metrolinx-run.sh prompts "Confirm: spend credits?"
 * unless it is given, and with no TTY `read` gets EOF, the answer is empty, and the run aborts.
 * Observed live. The launcher deliberately does NOT auto-confirm on a non-TTY, so the runner must
 * say yes explicitly — which is correct: an automated launch should have to state its intent.
 */
function buildLaunchArgv(request, opts = {}) {
  buildLaunchEnv(request, opts);      // validate by the same rules; throws for a bad request
  return ['--yes'];
}

export { buildLaunchEnv, buildLaunchArgv };
