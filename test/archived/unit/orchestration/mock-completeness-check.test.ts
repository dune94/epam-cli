/**
 * Root cause addressed: recurring live diagnoses for SKY-004 ("vi.mock factory
 * for SkyscannerClient omits `search` method", "vi.mock factory is incomplete;
 * unmocked methods are undefined, handlers throw 500s") kept happening despite
 * a [Self-Heal] skill note already in the system prompt from attempt 1:
 * "Always mock ALL exported methods or spread real ones via vi.importActual."
 * The note was present and specific; the agent ignored it anyway — prompt
 * compliance for this rule measured at effectively 0% across observed runs.
 *
 * Fix: run_mock_completeness_check() makes the fact deterministic instead of
 * asking the model to remember it. For every `vi.mock('<path>', () => ({
 * ClassName: vi.fn().mockImplementation(() => ({ ...methods... })) }))`
 * factory in a test file, it resolves <path> to the real source file, parses
 * the REAL class's actual method names (same extraction approach as
 * generate_story_contract), and fails fast — before the slow test run, same
 * pattern as run_relative_import_check — if any real method is absent from
 * the mock.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('claude.sh — run_mock_completeness_check() design', () => {
  const fnStart = claudeSrc.indexOf('run_mock_completeness_check()');
  const fnEnd = claudeSrc.indexOf('\nrun_relative_import_check', fnStart);
  const body = claudeSrc.slice(fnStart, fnEnd);

  it('function is defined', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  it('does NOT auto-rewrite the mock — only detects and reports (safer than silent auto-fix)', () => {
    expect(body).not.toMatch(/sed -i|\.replace\(|open\([^)]*['"]w['"]\)/);
  });

  it('is wired into run_external_verification after run_relative_import_check, before the test command runs', () => {
    const importCheckIdx = claudeSrc.indexOf('run_relative_import_check "$PROJECT_ROOT"');
    const mockCheckIdx = claudeSrc.indexOf('run_mock_completeness_check "$PROJECT_ROOT"');
    const testCmdIdx = claudeSrc.indexOf('Running external verification: $test_cmd');
    expect(importCheckIdx).toBeGreaterThan(-1);
    expect(mockCheckIdx).toBeGreaterThan(importCheckIdx);
    expect(mockCheckIdx).toBeLessThan(testCmdIdx);
  });

  it('skips the test run entirely on an incomplete mock (same fail-fast pattern as relative-import-check)', () => {
    const mockCheckIdx = claudeSrc.indexOf('run_mock_completeness_check "$PROJECT_ROOT"');
    const returnIdx = claudeSrc.indexOf('return 1', mockCheckIdx);
    const testCmdIdx = claudeSrc.indexOf('Running external verification: $test_cmd');
    expect(returnIdx).toBeGreaterThan(mockCheckIdx);
    expect(returnIdx).toBeLessThan(testCmdIdx);
  });

  it('sets VERIFICATION_FAILURE so the existing failure-analyst/retry-prompt channel picks it up', () => {
    expect(body).toMatch(/VERIFICATION_FAILURE=\$\(printf/);
  });

  it('is config-driven (2026-07-06 refactor): opt-in on .epam/contract-generation.json presence, zero hardcoded vi.fn()/vi.mock() literals — all patterns come from cfg[...]', () => {
    expect(body).toMatch(/config_file="\$\{project_root\}\/\.epam\/contract-generation\.json"/);
    expect(body).toMatch(/\[ -f "\$config_file" \] \|\| return 0/);
    for (const key of [
      'testFileExtensions', 'testFilePattern', 'classPattern', 'methodPattern',
      'mockFactoryStartPattern', 'mockClassPattern', 'mockedMethodPattern',
    ]) {
      expect(body).toContain(`cfg['${key}']`);
    }
    // No hardcoded REGEX pattern for the mock syntax itself — the compiled
    // regex objects (MOCK_START_RE/CLASS_MOCK_RE/MOCKED_METHOD_RE) must come
    // from cfg[...], not a literal vi.mock(...) regex string. Human-readable
    // diagnostic prose describing the failure (e.g. an f-string saying
    // "vi.mock() factory ... is missing") is fine — only the MATCHING logic
    // needs to be stack-agnostic.
    expect(body).not.toMatch(/re\.compile\(r?["']vi\\?\.mock/);
    expect(body).not.toMatch(/re\.compile\(r?["']vi\\?\.fn/);
  });
});

// Mirrors the manifest tier3-travel-app-run.sh embeds at
// .epam/contract-generation.json — run_mock_completeness_check() is opt-in on
// this file's presence (2026-07-06 config-driven refactor), same pattern as
// generate_story_contract().
const CONTRACT_GEN_CONFIG = {
  language: 'typescript',
  sourceExtensions: ['.ts'],
  excludePattern: '\\.(test|spec)\\.ts$',
  interfacePattern: 'export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}',
  classPattern: 'export\\s+class\\s+(\\w+)\\s*(?:extends\\s+\\w+\\s*)?\\{',
  ctorPattern: 'constructor\\s*\\(([^)]*)\\)',
  methodPattern: '^\\s*(?:public\\s+|private\\s+|protected\\s+)?(async\\s+)?(\\w+)\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{;]+))?\\s*\\{',
  interfaceRenderTemplate: 'export interface {{name}} {{{body}}}',
  classDeclarationTemplate: 'export class {{className}} {\n  constructor({{ctorParams}});\n{{methodSignatures}}\n}',
  methodSignatureTemplate: '  {{asyncPrefix}}{{methodName}}({{params}}){{returnAnnotation}};',
  asyncPrefixKeyword: 'async ',
  returnAnnotationPrefix: ': ',
  mockFactoryTemplate: "vi.mock('<import-path-to-{{className}}>', () => ({\n  {{className}}: vi.fn().mockImplementation(() => ({\n{{methodMocks}}\n  })),\n}));",
  mockMethodTemplateSync: '    {{methodName}}: vi.fn(),',
  mockMethodTemplateAsync: '    {{methodName}}: vi.fn().mockResolvedValue(undefined),',
  testFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  testFilePattern: '\\.(test|spec)\\.[a-zA-Z0-9]+$',
  mockFactoryStartPattern: "vi\\.mock\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\{",
  mockClassPattern: '(\\w+)\\s*:\\s*vi\\.fn\\(\\)\\.mockImplementation\\(\\(\\)\\s*=>\\s*\\(\\{',
  mockedMethodPattern: '^\\s*(\\w+)\\s*:',
};

describe('run_mock_completeness_check — REAL execution', () => {
  function runCheck(files: Record<string, string>): { rc: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mock-completeness-test-'));
    try {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam', 'contract-generation.json'), JSON.stringify(CONTRACT_GEN_CONFIG));
      for (const [relPath, content] of Object.entries(files)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const fnBody = claudeSrc.slice(
        claudeSrc.indexOf('run_mock_completeness_check()'),
        claudeSrc.indexOf('\nrun_relative_import_check'),
      );
      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(scriptPath, `${fnBody}\nrun_mock_completeness_check "${dir}" "${outLog}"\necho "RC=$?"\ncat "${outLog}" 2>/dev/null || true\n`);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      return { rc, output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live SKY-004 defect: mock omits a real method (getApiKey) and is flagged', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor(apiKey: string) {}
  async search(from: string, to: string): Promise<any[]> { return []; }
  getApiKey(): string { return ''; }
}
`,
      'src/server.test.ts': `
import { vi } from 'vitest';
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
  })),
}));
`,
    });
    expect(rc).toBe(1);
    expect(output).toContain("missing method(s): getApiKey");
    expect(output).toContain('SkyscannerClient');
  });

  it('passes cleanly when the mock covers every real method', () => {
    const { rc } = runCheck({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor(apiKey: string) {}
  async search(from: string, to: string): Promise<any[]> { return []; }
  getApiKey(): string { return ''; }
}
`,
      'src/server.test.ts': `
import { vi } from 'vitest';
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
    getApiKey: vi.fn(),
  })),
}));
`,
    });
    expect(rc).toBe(0);
  });

  it('REGRESSION (live, 2026-07-06): does NOT false-flag a phantom "if" method — a constructor containing `if (!key) { throw ... }` used to be misparsed as a class method named "if", falsely rejecting a correct, complete mock and burning the entire retry/escalation ladder on a check bug, not a real defect (root cause of repeated SKY-003 failures)', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  private readonly apiKey: string;
  constructor({ apiKey }: { apiKey?: string }) {
    const key = apiKey ?? process.env.RAPIDAPI_KEY;
    if (!key || key === '') {
      throw new Error('SkyscannerClient requires an apiKey');
    }
    this.apiKey = key;
  }
  async searchFlights(params: unknown): Promise<any[]> {
    if (params) {
      return [];
    }
    return [];
  }
}
`,
      'src/cli.test.ts': `
import { vi } from 'vitest';
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    searchFlights: vi.fn(),
  })),
}));
`,
    });
    expect(rc).toBe(0);
    expect(output).not.toContain('if');
  });

  it('still catches a genuinely incomplete mock on the SAME class that has nested if-statements (the fix does not just suppress all detection)', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor({ apiKey }: { apiKey?: string }) {
    if (!apiKey) {
      throw new Error('required');
    }
  }
  async searchFlights(params: unknown): Promise<any[]> { return []; }
  parseFlightResults(data: unknown): any[] { return []; }
}
`,
      'src/cli.test.ts': `
import { vi } from 'vitest';
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    searchFlights: vi.fn(),
  })),
}));
`,
    });
    expect(rc).toBe(1);
    expect(output).toContain('missing method(s): parseFlightResults');
    expect(output).not.toMatch(/missing method\(s\):.*\bif\b/);
  });

  it('the depth-fix is domain-agnostic — proves this with an unrelated e-commerce-style class (Cart), not travel-app fixtures, so a future non-travel project is equally protected', () => {
    const { rc: rcComplete } = runCheck({
      'src/cart/Cart.ts': `
export class Cart {
  private items: string[] = [];
  addItem(sku: string) {
    if (!sku || sku.length === 0) {
      throw new Error('sku required');
    }
    for (const existing of this.items) {
      if (existing === sku) {
        return;
      }
    }
    this.items.push(sku);
  }
  async checkout(paymentToken: string): Promise<boolean> {
    while (!paymentToken) {
      break;
    }
    return true;
  }
}
`,
      'src/order.test.ts': `
import { vi } from 'vitest';
vi.mock('./cart/Cart', () => ({
  Cart: vi.fn().mockImplementation(() => ({
    addItem: vi.fn(),
    checkout: vi.fn().mockResolvedValue(true),
  })),
}));
`,
    });
    expect(rcComplete).toBe(0);

    const { rc: rcIncomplete, output } = runCheck({
      'src/cart/Cart.ts': `
export class Cart {
  addItem(sku: string) {
    if (!sku) {
      throw new Error('sku required');
    }
  }
  async checkout(paymentToken: string): Promise<boolean> {
    return true;
  }
}
`,
      'src/order.test.ts': `
import { vi } from 'vitest';
vi.mock('./cart/Cart', () => ({
  Cart: vi.fn().mockImplementation(() => ({
    addItem: vi.fn(),
  })),
}));
`,
    });
    expect(rcIncomplete).toBe(1);
    expect(output).toContain('missing method(s): checkout');
    expect(output).not.toMatch(/missing method\(s\):.*\b(if|for|while)\b/);
  });

  it('passes cleanly when there are no vi.mock() factories at all', () => {
    const { rc } = runCheck({
      'src/index.ts': "export const x = 1;",
    });
    expect(rc).toBe(0);
  });

  it('does not flag a mock for a class that has no matching real file (defers to relative-import-check)', () => {
    const { rc } = runCheck({
      'src/server.test.ts': `
import { vi } from 'vitest';
vi.mock('./nonexistent/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    search: vi.fn(),
  })),
}));
`,
    });
    expect(rc).toBe(0);
  });

  it('reports multiple missing methods together, not just the first one found', () => {
    const { rc, output } = runCheck({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor(apiKey: string) {}
  async search(from: string, to: string): Promise<any[]> { return []; }
  getApiKey(): string { return ''; }
  getBaseUrl(): string { return ''; }
}
`,
      'src/server.test.ts': `
import { vi } from 'vitest';
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
  })),
}));
`,
    });
    expect(rc).toBe(1);
    expect(output).toContain('getApiKey');
    expect(output).toContain('getBaseUrl');
  });

  it('ignores private (#-prefixed) methods — those should never need to appear in a mock', () => {
    const { rc } = runCheck({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor(apiKey: string) {}
  async search(from: string, to: string): Promise<any[]> { return []; }
  #internalHelper(): void {}
}
`,
      'src/server.test.ts': `
import { vi } from 'vitest';
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
  })),
}));
`,
    });
    expect(rc).toBe(0);
  });
});
