import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { execa } from 'execa';

export const MANAGED_DASHBOARD_FILES = [
  'agent-activity.html',
  'agent-messages.html',
  'agent-profiles.html',
  'agents-orchestration.html',
  'cpa-details.html',
  'epam-cli-guide.html',
  'monitor.html',
  'orchestration-plan.html',
  'phase-cost-monitor.html',
  'pipeline-stages.html',
  'prd-viewer.html',
  'quality-assurance.html',
  'quality-dashboard.html',
  'specification.html',
] as const;

const REQUIRED_INPUT_FILES = [
  join('orchestrations', 'prd.json'),
  join('orchestrations', 'agents', 'profiles.json'),
  join('orchestrations', 'dashboards', '.eleventy.js'),
];

const SEEDED_JSONL_LOGS = [
  'agent-activity.jsonl',
  'agent-messages.jsonl',
  'code-reviews.jsonl',
  'cpa-review.jsonl',
  'phase-cost.jsonl',
  'phase-gates.jsonl',
  'profiles-audit.jsonl',
  'testing-gates.jsonl',
];

const SEEDED_JSON_LOGS: Record<string, unknown> = {
  'agent-status.json': {
    phase: null,
    story: null,
    progress: 0,
    status: 'idle',
    updatedAt: new Date(0).toISOString(),
  },
};

export interface DashboardHydrationOptions {
  targetPath: string;
  requiredRoles?: string[];
}

export interface DashboardHydrationResult {
  dashboardsDir: string;
  outputDir: string;
  builtFiles: string[];
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some(n => n && haystack.includes(n));
}

async function verifySemanticPages(
  outputDir: string,
  prd: Record<string, unknown>,
): Promise<void> {
  const project = (prd.project ?? {}) as Record<string, unknown>;
  const phaseKeys = Object.keys((prd.implementationOrder ?? {}) as Record<string, unknown>);

  const orchestrationPlanHtml = await fs.readFile(join(outputDir, 'orchestration-plan.html'), 'utf-8');
  const identityNeedles = [
    String(prd.id ?? ''),
    String(prd.title ?? ''),
    String(project.name ?? ''),
  ].filter(Boolean);
  if (!includesAny(orchestrationPlanHtml, identityNeedles)) {
    throw new Error(
      'Dashboard verification failed for orchestration-plan.html: page does not include project identity (id/title/name) from generated PRD',
    );
  }
  if (orchestrationPlanHtml.includes('automation/scripts/run-agent-orchestration.sh')) {
    throw new Error(
      'Dashboard verification failed for orchestration-plan.html: legacy automation script references detected (template appears static)',
    );
  }

  const agentProfilesHtml = await fs.readFile(join(outputDir, 'agent-profiles.html'), 'utf-8');
  const hasProfilesWiring =
    agentProfilesHtml.includes("fetchJSON('profiles.json')") ||
    agentProfilesHtml.includes("fetchText('profiles.json')") ||
    agentProfilesHtml.includes('parseLooseRoleMap');
  const hasPrdWiring = agentProfilesHtml.includes("fetchJSON('prd.json')");
  if (!hasProfilesWiring || !hasPrdWiring) {
    throw new Error(
      'Dashboard verification failed for agent-profiles.html: missing project data wiring to profiles.json/prd.json',
    );
  }

  const pipelineStagesHtml = await fs.readFile(join(outputDir, 'pipeline-stages.html'), 'utf-8');
  if (!pipelineStagesHtml.includes('profiles.json') || !pipelineStagesHtml.includes('phase-gates.jsonl')) {
    throw new Error(
      'Dashboard verification failed for pipeline-stages.html: missing expected orchestration data references',
    );
  }
  if (phaseKeys.length > 0 && !includesAny(pipelineStagesHtml, phaseKeys)) {
    throw new Error(
      'Dashboard verification failed for pipeline-stages.html: none of the generated phase ids are represented in the rendered page',
    );
  }

  const qualityAssuranceHtml = await fs.readFile(join(outputDir, 'quality-assurance.html'), 'utf-8');
  if (!qualityAssuranceHtml.includes('phase-gates.jsonl') || !qualityAssuranceHtml.includes('fetch(')) {
    throw new Error(
      'Dashboard verification failed for quality-assurance.html: missing gate-log fetch wiring',
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function applyProjectIdentityToOrchestrationPlan(
  outputDir: string,
  prd: Record<string, unknown>,
): Promise<void> {
  const file = join(outputDir, 'orchestration-plan.html');
  let html = await fs.readFile(file, 'utf-8');

  const project = (prd.project ?? {}) as Record<string, unknown>;
  const stack = (project.stack ?? {}) as Record<string, unknown>;
  const storyCount = Array.isArray(prd.stories) ? prd.stories.length : 0;
  const phaseCount = Object.keys((prd.implementationOrder ?? {}) as Record<string, unknown>).length;
  const projectName = String(project.name ?? prd.title ?? prd.id ?? 'Generated Project');
  const language = String(stack.language ?? '').trim();
  const runtime = String(stack.runtime ?? '').trim();
  const stackText = [language, runtime].filter(Boolean).join('/');

  const titleText = `${escapeHtml(projectName)} — Orchestration Plan`;
  const subtitleText = `${phaseCount} phases · <strong>${storyCount} stories</strong>${stackText ? ` · ${escapeHtml(stackText)} stack` : ''}`;

  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${titleText}</title>`,
  );
  html = html.replace(
    /<h1>[\s\S]*?<\/h1>/,
    `<h1>${titleText}</h1>`,
  );
  html = html.replace(
    /<p class="subtitle">[\s\S]*?<\/p>/,
    `<p class="subtitle">${subtitleText}</p>`,
  );

  await fs.writeFile(file, html, 'utf-8');
}

async function ensurePathExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    throw new Error(`Dashboard hydration missing required file: ${path}`);
  }
}

async function validateInputs(targetPath: string): Promise<void> {
  const checks = REQUIRED_INPUT_FILES.map(rel => ensurePathExists(resolve(targetPath, rel)));
  await Promise.all(checks);
}

async function seedLogs(targetPath: string): Promise<void> {
  const logsDir = resolve(targetPath, 'orchestrations', 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  for (const name of SEEDED_JSONL_LOGS) {
    const path = join(logsDir, name);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, '', 'utf-8');
    }
  }

  for (const [name, payload] of Object.entries(SEEDED_JSON_LOGS)) {
    const path = join(logsDir, name);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
    }
  }
}

async function buildDashboards(targetPath: string): Promise<void> {
  const dashboardsDir = resolve(targetPath, 'orchestrations', 'dashboards');
  const configPath = resolve(dashboardsDir, '.eleventy.js');
  const args = ['--yes', '@11ty/eleventy', `--config=${configPath}`];

  try {
    await execa('npx', args, {
      cwd: dashboardsDir,
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Dashboard build failed: ${message}`);
  }
}

async function verifyOutput(targetPath: string, requiredRoles: string[] = []): Promise<string[]> {
  const dashboardsDir = resolve(targetPath, 'orchestrations', 'dashboards');
  const outputDir = resolve(dashboardsDir, 'live');

  await ensurePathExists(outputDir);

  const missing: string[] = [];
  for (const file of MANAGED_DASHBOARD_FILES) {
    try {
      await fs.access(join(outputDir, file));
    } catch {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Dashboard verification failed, missing built files: ${missing.join(', ')}`);
  }

  const profilesPath = join(outputDir, 'profiles.json');
  const profilesRaw = await fs.readFile(profilesPath, 'utf-8');
  const profiles = JSON.parse(profilesRaw) as Record<string, unknown>;
  const absentRoles = requiredRoles.filter(role => !(role in profiles));
  if (absentRoles.length > 0) {
    throw new Error(`Dashboard verification failed, profiles missing generated roles: ${absentRoles.join(', ')}`);
  }

  const prdRaw = await fs.readFile(join(outputDir, 'prd.json'), 'utf-8');
  const prd = JSON.parse(prdRaw) as Record<string, unknown>;
  if (!prd.id || !prd.project || !prd.implementationOrder) {
    throw new Error('Dashboard verification failed, live/prd.json is missing required PRD fields');
  }

  await applyProjectIdentityToOrchestrationPlan(outputDir, prd);
  await verifySemanticPages(outputDir, prd);

  return MANAGED_DASHBOARD_FILES.map(f => join(outputDir, f));
}

export async function hydrateDashboards(
  opts: DashboardHydrationOptions,
): Promise<DashboardHydrationResult> {
  const targetPath = resolve(opts.targetPath);
  await validateInputs(targetPath);
  await seedLogs(targetPath);
  await buildDashboards(targetPath);
  const builtFiles = await verifyOutput(targetPath, opts.requiredRoles ?? []);

  return {
    dashboardsDir: resolve(targetPath, 'orchestrations', 'dashboards'),
    outputDir: resolve(targetPath, 'orchestrations', 'dashboards', 'live'),
    builtFiles,
  };
}
