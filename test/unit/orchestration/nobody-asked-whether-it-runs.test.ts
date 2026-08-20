// NO AGENT EVER ASKED WHETHER THE CHANGE RUNS IN THE TARGET RUNTIME.
//
// Live metrolinx AMSD-2041, three runs, three different implementations, two defects present in
// every one of them and raised by nobody:
//
//   1. src/pages/_app.tsx imports services/contentstack — a module that reads API_KEY and
//      DELIVERY_TOKEN and THROWS at module scope when they are absent. Next.js inlines only
//      NEXT_PUBLIC_-prefixed variables into the client bundle and this codeline's config exposes
//      no others, so in the browser they ARE absent. maintenance.tsx imports the same module only
//      inside getStaticProps, so the SSG transform strips it; _app.tsx uses it inside useEffect,
//      so it cannot be stripped.
//
//   2. next.config.js sets frame-ancestors 'self' and X-Frame-Options SAMEORIGIN, and names no
//      Contentstack host in connect-src — so the CMS cannot embed the page and the page cannot
//      call the CMS. The feature is impossible however well the source is written.
//
// Neither is a style question, a test-coverage question, or a security question. Both are the same
// question — WILL THIS RUN, AS THIS CODELINE IS CONFIGURED — and no seam owned it. The code
// reviewer judges the diff; the SAST sentinel judges vulnerabilities; the client-env plugin scans
// changed files for direct process.env reads and is one import hop short.
//
// This is the one genuinely absent agent. Its inputs all exist already: the changed files, the
// configuration surface (client-env-boundary-plugin's configSurface, keyed on the repository's own
// manifest), and an import graph via the tools every read-only seam already holds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/runtime-boundary-review.json');

const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));
const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const body = (): string => {
  const j = template();
  return String(j.body ?? Object.values(j.bodies ?? {}).join('\n'));
};

describe('the seam is registered like every other', () => {
    // Registered under the convention its siblings use: every QA gate is qa-gate:<name>.
  const p = () => registry().profiles['qa-gate:runtime-boundary'];

  it('exists in the registry', () => {
    expect(p(), 'no seam owns "does this run in the target runtime"').toBeTruthy();
  });

  it('declares what it consumes and produces, like its siblings', () => {
    expect(p().produces).toBeTruthy();
    expect(Array.isArray(p().consumes)).toBe(true);
    expect(p().consumes.some((c: { kind: string; required?: boolean }) => c.required)).toBe(true);
  });

  it('can read the repository — the defect is one import hop from the diff', () => {
    // It must be able to follow an import and open a config file; a diff alone cannot show either.
    expect(['read-only', 'read-network', 'execute']).toContain(p().toolGrant);
  });

  it('names its template', () => {
    expect(p().template).toBe('runtime-boundary-review');
  });
});

describe('what it is asked', () => {
  it('receives the changed files', () => {
    expect(template().placeholders).toContain('__STORY_DIFF__');
  });

  it('receives the configuration surface, resolved from the codeline', () => {
    expect(template().placeholders).toContain('__CONFIG_SURFACE__');
  });

  it('is asked whether the change can execute where it will run', () => {
    expect(body().toLowerCase()).toMatch(/runtime|browser|client bundle|server/);
  });

  it('is pointed at the import graph, not just the diff', () => {
    expect(body().toLowerCase(), 'a module that throws is reachable only by following an import')
      .toMatch(/import/);
  });

  it('must produce evidence like every other verdict', () => {
    expect(body().toLowerCase()).toMatch(/evidence/);
  });

  it('names no framework, no variable prefix, no header of its own', () => {
    for (const fact of ['NEXT_PUBLIC', 'next.config', 'frame-ancestors', 'X-Frame-Options',
                        'getStaticProps', 'vite', 'REACT_APP_']) {
      expect(body(), `the template hardcodes the stack fact "${fact}"`).not.toContain(fact);
    }
  });

  it('says nothing rather than inventing a finding when it cannot tell', () => {
    expect(body().toLowerCase()).toMatch(/cannot|unable|do not (invent|guess)|no finding/);
  });
});

describe('and it actually runs', () => {
  // A registered seam nobody invokes is a capability that exists only on paper. Every other
  // capability found missing this week — the client-env boundary check, the escalation the
  // flip-flop guard calls — was written and then not reached.
  const sh = () => readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('is invoked through the same gate machinery as its siblings', () => {
    expect(sh(), 'the seam is registered but nothing calls it')
      .toMatch(/_run_qa_gate_with_retry .*qa-gate:runtime-boundary/);
  });

  it('renders its prompt from the template layer', () => {
    expect(sh()).toMatch(/render_engine_prompt runtime-boundary-review/);
  });

  it('is handed the configuration surface the detective also gets', () => {
    const block = sh().slice(sh().indexOf('runtime-boundary'), sh().indexOf('runtime-boundary') + 2500);
    expect(block).toMatch(/__CONFIG_SURFACE__/);
  });

  it('appears in the operator checklist, so a skipped run is visible', () => {
    expect(sh()).toMatch(/_checklist_row "22g"/);
  });

  it('refuses to gate rather than run with no instructions', () => {
    const i = sh().indexOf('render_engine_prompt runtime-boundary-review');
    expect(sh().slice(i, i + 400)).toMatch(/refusing to gate|cannot render/);
  });
});

describe('its verdict is waited for', () => {
  const sh = () => readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('the background job is waited on, not left running past the phase', () => {
    // First wiring launched it with & and never waited: the phase would move on while the gate was
    // still thinking, and its verdict would land after anyone could act on it.
    expect(sh()).toMatch(/wait \$_rb_pid/);
  });

  it('and its outcome reaches the step checklist either way', () => {
    expect(sh()).toMatch(/step_emit "22g" "pass"/);
    expect(sh()).toMatch(/step_emit "22g" "fail"/);
  });
});
