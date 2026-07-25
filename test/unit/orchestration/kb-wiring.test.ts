/**
 * WIRING — the KB reaches an agent as ENFORCEMENT, and by no other route.
 *
 * Two seams only:
 *   kb-cli.js record  — the pipeline writes an episode (signature from tool output)
 *   kb-cli.js apply   — emits shell `export` lines + a gate list for the invoker
 *
 * `apply` deliberately emits ONLY env assignments and gate ids. There is no
 * free-text output channel, so healed knowledge physically cannot degrade back into
 * a prompt appendix — which is what the existing path does
 * (COORDINATOR_PROMPT_AMENDMENT, trimmed to the last 3 headings past ~16000 chars).
 *
 * The closed loop under test: a failure is recorded with a tool-derived signature,
 * a constraint is synthesised from it, and the NEXT invocation of that agent role
 * carries the constraint as an env parameter it cannot exceed.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const CLI = join(LIB, 'kb-cli.js');
const GATEWAY = join(LIB, 'agent-invoke.sh');
const NODE = process.execPath;
const dirs: string[] = [];
let kbRoot: string;
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

beforeEach(() => { kbRoot = mkdtempSync(join(tmpdir(), 'kb-wire-')); dirs.push(kbRoot); });

const cli = (args: string[], input = '') =>
  execFileSync(NODE, [CLI, ...args], { encoding: 'utf8', input, env: { ...process.env, KB_ROOT: kbRoot } });

describe('record — the signature comes from tool output', () => {
  it('keys on the compiler code, not on the diagnosis prose', () => {
    cli(['record', '--id', 'e1', '--agent-role', 'typescript-engineer', '--story', 'S-1',
         '--diagnosis', 'Missing closing brace causing a problem'],
        "src/a.ts(77,3): error TS1005: ';' expected.");
    const ep = JSON.parse(readFileSync(join(kbRoot, 'healing-events.jsonl'), 'utf8').trim());
    expect(ep.signature).toBe('TS1005');
    expect(ep.signature_source).toBe('tsc');
  });

  it('records a null signature rather than inventing one', () => {
    cli(['record', '--id', 'e2', '--agent-role', 'r', '--diagnosis', 'the agent was confused'], 'no tool signal');
    const ep = JSON.parse(readFileSync(join(kbRoot, 'healing-events.jsonl'), 'utf8').trim());
    expect(ep.signature).toBeNull();
  });
});

describe('apply — emits enforcement, never prose', () => {
  beforeEach(() => {
    cli(['record', '--id', 'e1', '--agent-role', 'typescript-engineer'], 'src/a.ts(1,1): error TS2532: x');
    cli(['synthesize', '--agent-role', 'typescript-engineer', '--signature', 'TS2532',
         '--enforcement', JSON.stringify({ kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '14' }),
         '--reason', 'repeated strict-null failure']);
  });

  it('emits a shell export for a matching role+signature', () => {
    const out = cli(['apply', '--agent-role', 'typescript-engineer', '--signatures', 'TS2532']);
    expect(out).toContain("export EPAM_MAX_ITERATIONS='14'");
  });

  it('emits nothing for a role with no constraints', () => {
    expect(cli(['apply', '--agent-role', 'test-engineer', '--signatures', 'TS2532']).trim()).toBe('');
  });

  it('emits NO free text — the reason never reaches the agent', () => {
    const out = cli(['apply', '--agent-role', 'typescript-engineer', '--signatures', 'TS2532']);
    expect(out).not.toMatch(/repeated strict-null|reason|diagnosis/i);
  });

  it('exports gate ids as a single list the caller can act on', () => {
    cli(['synthesize', '--agent-role', 'typescript-engineer', '--signature', 'TS1005',
         '--enforcement', JSON.stringify({ kind: 'gate', check: 'parse-before-commit' }), '--reason', 'r']);
    const out = cli(['apply', '--agent-role', 'typescript-engineer', '--signatures', 'TS1005']);
    expect(out).toMatch(/export KB_GATES='parse-before-commit'/);
  });
});

describe('gateway integration — constraints reach the real invocation', () => {
  it('invoke_agent applies a compiled constraint to the agent env', () => {
    cli(['record', '--id', 'e1', '--agent-role', 'typescript-engineer'], 'src/a.ts(1,1): error TS2532: x');
    cli(['synthesize', '--agent-role', 'typescript-engineer', '--signature', 'TS2532',
         '--enforcement', JSON.stringify({ kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '14' }),
         '--reason', 'r']);

    const stub = join(kbRoot, 'stub.sh');
    const dump = join(kbRoot, 'env.txt');
    writeFileSync(stub, `#!/usr/bin/env bash\nexport -p | sed -n 's/^declare -x //p' > ${JSON.stringify(dump)}\ncat >/dev/null\necho OK\n`);
    chmodSync(stub, 0o755);

    execFileSync('bash', ['-c',
      `set -uo pipefail
       source ${JSON.stringify(GATEWAY)}
       printf p | invoke_agent team-lead-review --runner ${JSON.stringify(stub)}`,
    ], { encoding: 'utf8', env: { ...process.env, KB_ROOT: kbRoot,
         KB_AGENT_ROLE: 'typescript-engineer', KB_SIGNATURES: 'TS2532' } });

    const env: Record<string, string> = {};
    for (const line of readFileSync(dump, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
    }
    // The healed constraint overrides the profile default (25) — enforcement, not advice.
    expect(env.EPAM_MAX_ITERATIONS).toBe('14');
  });

  it('a run with no KB context is completely unaffected', () => {
    const stub = join(kbRoot, 'stub2.sh');
    const dump = join(kbRoot, 'env2.txt');
    writeFileSync(stub, `#!/usr/bin/env bash\nexport -p | sed -n 's/^declare -x //p' > ${JSON.stringify(dump)}\ncat >/dev/null\necho OK\n`);
    chmodSync(stub, 0o755);
    execFileSync('bash', ['-c',
      `set -uo pipefail
       source ${JSON.stringify(GATEWAY)}
       printf p | invoke_agent team-lead-review --runner ${JSON.stringify(stub)}`,
    ], { encoding: 'utf8', env: { ...process.env, KB_ROOT: kbRoot } });
    const txt = readFileSync(dump, 'utf8');
    expect(txt).toMatch(/EPAM_MAX_ITERATIONS="?25/);   // the profile default, untouched
  });
});
