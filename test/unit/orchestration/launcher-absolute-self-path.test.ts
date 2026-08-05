/**
 * A LAUNCHER MUST NOT INVOKE THE ORCHESTRATOR BY RELATIVE PATH.
 *
 * The orchestrator re-invokes ITSELF per codeline (`bash "$0" --reset`). If it was started
 * with a relative path, `$0` is relative — and the sequential single-lane branch runs that
 * re-invocation in the SAME shell, after the lane loop has cd'd into the client codeline.
 * The path then resolves against the client repo and dies:
 *
 *   bash: orchestrations/scripts/run-agent-orchestration.sh: No such file or directory
 *   [ERROR] Phase 'core' for 'metrolinx' failed (exit 127)
 *
 * Live 2026-08-05, the first single-lane run. Multi-lane runs never exposed it: the
 * parallel branch (gated on >1 lane) runs each lane in a SUBSHELL, so its `cd` cannot leak
 * into the next invocation. One lane falls to the sequential branch, and the latent bug
 * became reachable the moment EPAM_CODELINE_FILTER made single-lane possible.
 *
 * Same family as the standing rule for git in lane code: never depend on the working
 * directory in anything a lane can run.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const launchers = readdirSync(SCRIPTS).filter((f) => /^tier\d.*-run\.sh$/.test(f));

describe('launchers invoke the orchestrator by absolute path', () => {
  it('there are launchers to check — otherwise this proves nothing', () => {
    expect(launchers.length).toBeGreaterThan(0);
  });

  it.each(launchers)('%s uses no relative path to run-agent-orchestration.sh', (f) => {
    const relative = readFileSync(join(SCRIPTS, f), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('echo'))
      .filter((l) => /(^|\s)bash\s+(\S+\s+)*orchestrations\/scripts\/run-agent-orchestration\.sh/.test(l));
    expect(
      relative,
      `${f} invokes the orchestrator relatively, so its $0 is relative. The orchestrator ` +
        `re-invokes itself per codeline AFTER cd'ing into the client repo, which fails with ` +
        `exit 127 on any single-lane run:\n${relative.join('\n')}`,
    ).toEqual([]);
  });
});
