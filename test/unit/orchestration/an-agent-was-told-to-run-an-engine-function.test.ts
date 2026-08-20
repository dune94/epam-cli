// THE AGENT WAS TOLD TO VERIFY ITS WORK WITH A COMMAND THAT CANNOT EXIST IN ITS SHELL.
//
// repro-test-writer.json instructed the test writer:
//
//   ## VERIFY IT COMPILES BEFORE YOU FINISH
//   Your test must TYPECHECK, not merely run — a spec that passes the test runner but fails tsc
//   blocks the whole pipeline five steps later
//     _run_project_verification "__PROJECT_ROOT__" 2>&1 | grep "__TARGET_REL__"
//   If that prints anything, FIX YOUR FILE and re-check before finishing.
//
// `_run_project_verification` is a shell FUNCTION defined in claude.sh:5398. The agent's bash tool
// is a separate subprocess; engine functions do not exist there. Proven directly:
//
//   $ bash -c '_run_project_verification /some/repo 2>&1 | head -3; echo exit=$?'
//   bash: line 1: _run_project_verification: command not found
//   exit=0
//
// The error goes to stderr, `2>&1 | grep <target>` matches nothing, and the agent sees EMPTY
// OUTPUT. From the Langfuse trace of 2026-08-20, in the agent's own words:
//
//   "Good — no output means no typecheck errors for our file (grep exit code 1 = no matches)."
//
// "If that prints anything, FIX YOUR FILE" can never print anything. The instruction is
// unfalsifiable, and the prompt's own warning — "blocks the whole pipeline five steps later" — is
// exactly what then happened. 3 invocations and 5 false "clean" conclusions across 600 traced
// observations.
//
// THE CODELINE ALREADY DECLARES THE ANSWER. .epam/verification.json carries
// "npm run check-types", and verification-plugin's detectVerification() reads it. The prompt must
// name what the PROJECT declares — never an engine internal.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/repro-test-writer.json');
const PRODUCER = join(ROOT, 'orchestrations/scripts/brownfield-repro-test-writer.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const body = (): string => {
  const j = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  return String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
};

describe('the instruction is falsifiable', () => {
  it('names no engine-internal shell function', () => {
    expect(body(), 'the agent cannot run an engine function from its own shell')
      .not.toContain('_run_project_verification');
  });

  it('takes the command from the project instead', () => {
    expect(JSON.parse(readFileSync(TEMPLATE, 'utf8')).placeholders).toContain('__TYPECHECK_COMMAND__');
  });

  it('still tells the agent to verify before finishing', () => {
    // The requirement survives the fix: a spec that runs but does not typecheck blocks the
    // pipeline later, which is exactly why this instruction exists.
    expect(body().toLowerCase()).toMatch(/typecheck|type check|compiles/);
  });

  it('the producer supplies the command', () => {
    expect(readFileSync(PRODUCER, 'utf8')).toMatch(/__TYPECHECK_COMMAND__/);
  });
});

describe('the command it names is real', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = () => require(join(ROOT, 'orchestrations/plugins/verification-plugin.js'));

  function repo(withTypecheck: boolean): string {
    const d = mkdtempSync(join(tmpdir(), 'tc-cmd-')); made.push(d);
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({
      name: 'f', scripts: withTypecheck ? { 'check-types': 'tsc --noEmit' } : {},
    }));
    if (withTypecheck) {
      writeFileSync(join(d, '.epam/verification.json'), JSON.stringify({
        typecheck: { command: 'npm run check-types', detected: 'package.json scripts.check-types' },
      }));
    }
    return d;
  }

  it('resolves the declared command from a codeline that has one', () => {
    const v = plugin().detectVerification(repo(true));
    expect(v?.typecheck?.command).toBe('npm run check-types');
  });

  it('reports nothing for a codeline that declares none — never a phantom command', () => {
    const v = plugin().detectVerification(repo(false));
    expect(v?.typecheck?.command ?? '').toBe('');
  });

  it('a command that does not exist behaves as the defect did — silent empty output', () => {
    // This is what made the old instruction unfalsifiable. Kept as an executable statement of the
    // failure mode, so nobody has to take the explanation on trust.
    const r = spawnSync('bash', ['-c', '_run_project_verification /tmp 2>&1 | grep "src/thing.ts"'],
      { encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status, 'grep found nothing, so the agent concluded "clean"').not.toBe(0);
  });
});

describe('the class, not the site', () => {
  // 477 shell functions are defined across the engine. A prompt may name a tool the agent holds or
  // a command the project declares — never one of these.
  it('no prompt template names an engine shell function', () => {
    const fns = new Set<string>();
    for (const d of ['orchestrations/scripts', 'orchestrations/scripts/lib']) {
      for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.sh'))) {
        const s = readFileSync(join(ROOT, d, f), 'utf8');
        for (const m of s.matchAll(/^([a-z_][a-z0-9_]*)\(\)\s*\{/gm)) {
          // Short names collide with ordinary prose ("timestamp"); only distinctive ones are
          // evidence, and engine internals are conventionally prefixed or long.
          if (m[1].length >= 8 && (m[1].startsWith('_') || m[1].includes('_'))) fns.add(m[1]);
        }
      }
    }
    expect(fns.size, 'the function scan found nothing, so this proves nothing').toBeGreaterThan(50);

    const tdir = join(ROOT, 'orchestrations/prompts/templates');
    const offenders: string[] = [];
    for (const f of readdirSync(tdir).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(join(tdir, f), 'utf8'));
      const text = String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
      for (const fn of fns) if (text.includes(fn)) offenders.push(`${f} → ${fn}`);
    }
    expect(offenders, `a prompt instructs an agent to run an engine function:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
