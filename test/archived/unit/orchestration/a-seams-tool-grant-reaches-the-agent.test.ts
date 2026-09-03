/**
 * A SEAM'S TOOL GRANT REACHES THE AGENT.
 *
 * invocation-profiles.json lets a seam declare `allowedTools`, `maxIterations`,
 * `maxOutputTokens` and `timeoutSecs`. seamInvocationEnv exported none of them — only effort,
 * temperature, ladder and model. So every one of those declarations was inert: story-writer has
 * said `allowedTools: "bash,read_file,list_files,search"` for weeks and the writer never
 * received a single one of them through this path.
 *
 * That is the same defect as a ladder that resolves to nothing, in the same file, with the same
 * shape: a declaration nothing reads is documentation, and it reads as configuration.
 *
 * It became load-bearing when the prompt-builder needed READ access to the template zone. The
 * operator's design is that the agent which mints the roster also provisions the prompts, with
 * tool access to the templates so it can read them and decorate them for the project. A seam
 * that cannot hand its agent a tool grant cannot express that at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const AGENTS_DIR = join(ROOT, 'orchestrations/agents');
const REGISTRY = join(AGENTS_DIR, 'invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { seamInvocationEnv } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

/** A ladder is supplied so the tier resolution does not warn its way through every case. */
const envFor = (agent: string) =>
  seamInvocationEnv(agent, AGENTS_DIR, {
    env: {
      EPAM_MODEL_LADDER_TIER_ORDER: 'medium high highest',
      EPAM_MODEL_LADDER_HIGHEST: 'a=b',
      EPAM_MODEL_LADDER_MEDIUM: 'a=b',
    },
  });

describe('every setting a seam declares is actually exported', () => {
  it('is not vacuous — the seam under test really does declare these', () => {
    const p = registry().profiles['story-writer'];
    expect(p.allowedTools, 'story-writer stopped declaring tools, so the assertions below prove nothing').toBeTruthy();
    expect(p.maxIterations).toBeTruthy();
  });

  it('a declared tool grant arrives as EPAM_ALLOWED_TOOLS', () => {
    const p = registry().profiles['story-writer'];
    expect(
      envFor('story-writer').EPAM_ALLOWED_TOOLS,
      'the seam declares tools and the agent receives none — the grant is decoration',
    ).toBe(p.allowedTools);
  });

  it('the iteration, token and timeout budgets arrive too', () => {
    // Same class as the tool grant. A seam that declares maxIterations: 25 and hands over the
    // default of 1 has an agent that stops after one step, which reads as a model that gave up.
    const p = registry().profiles['story-writer'];
    const env = envFor('story-writer');
    expect(env.EPAM_MAX_ITERATIONS).toBe(String(p.maxIterations));
    expect(env.EPAM_MAX_OUTPUT_TOKENS).toBe(String(p.maxOutputTokens));
    expect(env.EPAM_TIMEOUT_SECS).toBe(String(p.timeoutSecs));
  });

  it('a seam that grants no tools exports no grant, rather than an empty one', () => {
    // An empty EPAM_ALLOWED_TOOLS is not the same as an absent one downstream: one says "these
    // zero tools", the other says "nothing was configured here". Only the second lets a caller's
    // own explicit grant stand.
    const withoutTools = Object.entries(registry().profiles)
      .find(([, p]: [string, any]) => !p.allowedTools);
    expect(withoutTools, 'every seam grants tools — this case is untested').toBeTruthy();
    expect(envFor(withoutTools![0]).EPAM_ALLOWED_TOOLS).toBeUndefined();
  });
});

describe('the prompt-builder is a seam of its own', () => {
  it('it no longer borrows the test-criteria writer’s configuration', () => {
    // It resolved through the `builder$` pattern to tc-writer, so the agent that provisions a
    // project's entire prompt library ran as an instance of a test-criteria writer — a different
    // job, a different budget, and no tools at all.
    expect(registry().profiles['prompt-builder'],
      'the prompt-builder has no profile, so it inherits whatever pattern happens to match its name',
    ).toBeTruthy();
  });

  it('it can READ the template zone', () => {
    // The operator's design: the agent copies and decorates the templates itself, so it has to
    // be able to open them. Without a read grant the only thing it can see is whatever the
    // engine pasted into its prompt.
    const tools = String(envFor('prompt-builder').EPAM_ALLOWED_TOOLS || '');
    expect(tools, 'the prompt-builder cannot open a template').toMatch(/read_file/);
    expect(tools, 'the prompt-builder cannot see which templates exist').toMatch(/list_files/);
  });

  it('it cannot run shell commands', () => {
    // Read and decorate is the whole job. A provisioning agent with bash could rewrite the
    // template zone it is reading from, and the template zone is the one thing in this design
    // that must stay immutable.
    expect(String(envFor('prompt-builder').EPAM_ALLOWED_TOOLS || '')).not.toMatch(/\bbash\b/);
  });

  it('it is told where the templates are', () => {
    // A read grant is useless without a path. The zone is resolved from the engine's own layout
    // and handed over as data, so no prompt has to name a directory.
    expect(envFor('prompt-builder').EPAM_PROMPT_TEMPLATES_DIR,
      'the builder has a read grant but no idea what to read',
    ).toBeTruthy();
  });
});
