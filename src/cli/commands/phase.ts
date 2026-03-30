import { Command } from 'commander';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { userInfo } from 'os';
import { resolve } from 'path';
import { createInterface } from 'node:readline/promises';
import {
  PhaseApprovalSnapshot,
  PhaseApprovalStatus,
  PhaseApproverIdentity,
  PhaseApprovalStore,
} from '../approval/PhaseApprovalStore.js';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { executeEstimate } from './estimate.js';
import { executeOrchestrate } from './orchestrate.js';

interface PhaseRunOptions {
  phase: string;
  model?: string;
  dryRun?: boolean;
  skipCpa?: boolean;
  strictCpa?: boolean;
  requireApproval?: boolean;
}

interface PhaseApproveOptions {
  phase: string;
}

interface PhaseSummary {
  phase: string;
  storyCount: number;
  status: 'success' | 'failed';
  approvalStatus?: PhaseApprovalStatus['status'];
  approver?: string;
  approvedAt?: string;
  estimateLog?: string;
  orchestrateLog?: string;
}

interface PrdStoryRecord {
  id: string;
  title: string;
  estimatedAiMinutes?: number;
  estimatedCost?: number;
  estimatedTokens?: number;
  estimatedTurns?: number;
}

interface PrdDocument {
  implementationOrder?: Record<string, string[]>;
  phasesConfig?: Record<string, { description?: string }>;
  stories?: PrdStoryRecord[];
}

interface PhaseStoryStatus {
  id: string;
  status?: string;
  completed?: boolean;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function logDirForRun(phase: string): string {
  return resolve(process.cwd(), 'orchestrations/logs/cli-phase-runner', `${phase}-${timestampId()}`);
}

function emitPhaseEvent(
  event: 'phase_start' | 'phase_complete' | 'phase_fail',
  payload: Record<string, unknown>,
): void {
  process.stdout.write(`${JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    source: 'epam-cli',
    ...payload,
  })}\n`);
}

function createModelSelectionEnv(config: Awaited<ReturnType<typeof resolveConfig>>): Record<string, string> {
  return {
    EPAM_PROVIDER: config.provider,
    EPAM_MODEL: config.model,
    EPAM_DEFAULT_MODEL: config.defaultModel,
    EPAM_MODEL_SOURCE: config.modelSelection.source,
    EPAM_MODEL_USED_DEFAULT: config.modelSelection.usedDefault ? '1' : '0',
    EPAM_ALLOWED_MODELS: JSON.stringify(config.allowedModels),
  };
}

async function withModelSelectionEnv<T>(
  config: Awaited<ReturnType<typeof resolveConfig>>,
  run: () => Promise<T>,
): Promise<T> {
  const envUpdates = createModelSelectionEnv(config);
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(envUpdates)) {
    previousValues.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, previousValue] of previousValues.entries()) {
      if (previousValue == null) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

function findPrdPath(): string | undefined {
  const rootPrdPath = resolve(process.cwd(), 'prd.json');
  if (existsSync(rootPrdPath)) {
    return rootPrdPath;
  }

  const orchestrationPrdPath = resolve(process.cwd(), 'orchestrations/prd.json');
  if (existsSync(orchestrationPrdPath)) {
    return orchestrationPrdPath;
  }

  return undefined;
}

function loadPrdDocument(): PrdDocument | undefined {
  const prdPath = findPrdPath();
  if (!prdPath) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(prdPath, 'utf8')) as PrdDocument;
  } catch {
    return undefined;
  }
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function resolvePhaseStoryIds(document: PrdDocument, phaseId: string): string[] {
  const implementationOrder = document.implementationOrder ?? {};
  if (Array.isArray(implementationOrder[phaseId])) {
    return implementationOrder[phaseId] ?? [];
  }

  const matchingStory = (document.stories ?? []).find(story => story.id === phaseId);
  return matchingStory ? [matchingStory.id] : [];
}

function resolveRunnablePhaseStoryIds(document: PrdDocument, phaseId: string): string[] {
  const phaseStoryIds = resolvePhaseStoryIds(document, phaseId);
  const storiesById = new Map(
    ((document.stories as Array<PrdStoryRecord & PhaseStoryStatus> | undefined) ?? []).map(story => [story.id, story] as const),
  );

  return phaseStoryIds.filter(storyId => {
    const story = storiesById.get(storyId);
    if (!story) {
      return false;
    }

    const status = story.status ?? 'pending';
    return status !== 'backlog' && status !== 'completed' && story.completed !== true;
  });
}

function buildPhaseSnapshot(phaseId: string): PhaseApprovalSnapshot {
  const document = loadPrdDocument();
  if (!document) {
    throw new Error('Unable to load prd.json. Run from the epam-cli project root.');
  }

  const storyIds = resolvePhaseStoryIds(document, phaseId);
  if (storyIds.length === 0) {
    throw new Error(`Phase "${phaseId}" was not found in implementationOrder.`);
  }

  const storiesById = new Map((document.stories ?? []).map(story => [story.id, story] as const));
  const stories = storyIds.map(storyId => {
    const story = storiesById.get(storyId);
    if (!story) {
      throw new Error(`Phase "${phaseId}" references story "${storyId}" but it is missing from prd.json.`);
    }

    return {
      id: story.id,
      title: story.title,
      estimatedMinutes: normalizeNumber(story.estimatedAiMinutes),
      estimatedCost: normalizeNumber(story.estimatedCost),
      estimatedTokens: normalizeNumber(story.estimatedTokens),
      estimatedTurns: normalizeNumber(story.estimatedTurns),
    };
  });

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(storyIds))
    .digest('hex');

  return {
    phaseId,
    phaseName: document.phasesConfig?.[phaseId]?.description ?? phaseId,
    storyIds,
    storyFingerprint: fingerprint,
    stories,
    estimates: stories.reduce(
      (totals, story) => ({
        minutes: totals.minutes + story.estimatedMinutes,
        cost: totals.cost + story.estimatedCost,
        tokens: totals.tokens + story.estimatedTokens,
        turns: totals.turns + story.estimatedTurns,
      }),
      { minutes: 0, cost: 0, tokens: 0, turns: 0 },
    ),
  };
}

function resolveApproverIdentity(): PhaseApproverIdentity {
  const preferredIdentity = [
    { value: process.env.EPAM_APPROVER, source: 'env:EPAM_APPROVER' },
    { value: process.env.GIT_AUTHOR_EMAIL, source: 'env:GIT_AUTHOR_EMAIL' },
    { value: process.env.EMAIL, source: 'env:EMAIL' },
    { value: process.env.GIT_AUTHOR_NAME, source: 'env:GIT_AUTHOR_NAME' },
    { value: process.env.USER, source: 'env:USER' },
    { value: process.env.USERNAME, source: 'env:USERNAME' },
  ].find(candidate => typeof candidate.value === 'string' && candidate.value.trim().length > 0);

  if (preferredIdentity?.value) {
    return {
      id: preferredIdentity.value,
      displayName: preferredIdentity.value,
      source: preferredIdentity.source,
    };
  }

  const currentUser = userInfo().username;
  return {
    id: currentUser,
    displayName: currentUser,
    source: 'os.userInfo',
  };
}

function approvalEventPayload(status: PhaseApprovalStatus): Record<string, unknown> {
  return {
    approvalStatus: status.status,
    approvalApprovedAt: status.approvedAt,
    approvalApproverId: status.approver?.id,
    approvalApproverName: status.approver?.displayName,
    approvalApproverSource: status.approver?.source,
    approvalInvalidReason: status.invalidReason,
  };
}

function printSummary(summary: PhaseSummary): void {
  process.stdout.write('\nPhase execution summary\n');
  process.stdout.write(`Phase: ${summary.phase}\n`);
  process.stdout.write(`Story count: ${summary.storyCount}\n`);
  process.stdout.write(`Status: ${summary.status}\n`);
  if (summary.approvalStatus) {
    process.stdout.write(`Approval status: ${summary.approvalStatus}\n`);
  }
  if (summary.approver) {
    process.stdout.write(`Approved by: ${summary.approver}\n`);
  }
  if (summary.approvedAt) {
    process.stdout.write(`Approved at: ${summary.approvedAt}\n`);
  }
  if (summary.estimateLog) {
    process.stdout.write(`Estimate log: ${summary.estimateLog}\n`);
  }
  if (summary.orchestrateLog) {
    process.stdout.write(`Orchestration log: ${summary.orchestrateLog}\n`);
  }
}

function printApprovalPreview(snapshot: PhaseApprovalSnapshot, status: PhaseApprovalStatus): void {
  process.stdout.write('\nPhase approval review\n');
  process.stdout.write(`Phase: ${snapshot.phaseId}\n`);
  process.stdout.write(`Description: ${snapshot.phaseName}\n`);
  process.stdout.write(`Story count: ${snapshot.storyIds.length}\n`);
  process.stdout.write(
    `Estimates: ${formatNumber(snapshot.estimates.minutes)} min, $${formatNumber(snapshot.estimates.cost)}, ${formatNumber(snapshot.estimates.tokens, 0)} tokens, ${formatNumber(snapshot.estimates.turns, 0)} turns\n`,
  );

  if (status.status === 'approved') {
    process.stdout.write(
      `Existing approval: ${status.approvedAt} by ${status.approver?.displayName ?? status.approver?.id ?? 'unknown'}\n`,
    );
  } else if (status.status === 'invalidated') {
    process.stdout.write(`Existing approval: invalidated (${status.invalidReason})\n`);
  } else {
    process.stdout.write('Existing approval: none\n');
  }

  process.stdout.write('Stories:\n');
  for (const story of snapshot.stories) {
    process.stdout.write(
      `- ${story.id}: ${story.title} [${formatNumber(story.estimatedMinutes)} min, $${formatNumber(story.estimatedCost)}, ${formatNumber(story.estimatedTokens, 0)} tokens, ${formatNumber(story.estimatedTurns, 0)} turns]\n`,
    );
  }
}

async function confirmApproval(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Approval confirmation requires an interactive terminal.');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Approve this phase for execution? [y/N] ');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export function createPhaseCommand(): Command {
  const approvalStore = new PhaseApprovalStore();
  const phase = new Command('phase')
    .description('Phase control plane commands');

  phase.addCommand(
    new Command('approve')
      .description('Record explicit human approval for a phase')
      .requiredOption('--phase <id>', 'Phase to approve')
      .action(async (opts: PhaseApproveOptions) => {
        try {
          const snapshot = buildPhaseSnapshot(opts.phase);
          const status = approvalStore.getApprovalStatus(snapshot);

          printApprovalPreview(snapshot, status);
          const confirmed = await confirmApproval();
          if (!confirmed) {
            process.stderr.write('Approval aborted.\n');
            process.exit(1);
          }

          const record = approvalStore.appendApproval(snapshot, resolveApproverIdentity());
          process.stdout.write(
            `Approval recorded for ${record.phaseId} at ${record.approvedAt} by ${record.approver.displayName}.\n`,
          );
          process.stdout.write(`Approval log: ${approvalStore.getLogPath()}\n`);
          process.exit(0);
        } catch (error) {
          process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        }
      }),
  );

  phase.addCommand(
    new Command('run')
      .description('Run estimate, optional CPA pass, and orchestration for a phase')
      .requiredOption('--phase <id>', 'Phase to execute')
      .option('--model <name>', 'Model override; must exist in the configured EPAM allow-list')
      .option('--dry-run', 'Preview execution without writing changes')
      .option('--skip-cpa', 'Skip the CPA contextualisation pass and orchestration CPA gate')
      .option('--strict-cpa', 'Halt if the CPA pass returns review or block gates')
      .option('--require-approval', 'Require a valid human approval record before execution')
      .action(async (opts: PhaseRunOptions) => {
        try {
          const config = await resolveConfig({ model: opts.model });
          const phaseId = opts.phase;
          const logsDir = logDirForRun(phaseId);
          const estimateLog = resolve(logsDir, 'estimate.log');
          const orchestrateLog = resolve(logsDir, 'orchestrate.log');
          const snapshot = buildPhaseSnapshot(phaseId);
          const runnableStoryIds = resolveRunnablePhaseStoryIds(loadPrdDocument() ?? {}, phaseId);
          const approvalStatus = approvalStore.getApprovalStatus(snapshot);
          const storyCount = snapshot.storyIds.length;
          const runnableStoryCount = runnableStoryIds.length;

          if (config.provider === 'epam' && config.modelSelection.usedDefault) {
            process.stderr.write(
              `Model selection: resolved default "${config.model}" via ${config.modelSelection.source} (${config.modelSelection.reason}).\n`,
            );
          } else if (config.provider === 'epam') {
            process.stderr.write(
              `Model selection: using "${config.model}" via ${config.modelSelection.source}.\n`,
            );
          }

          if (opts.requireApproval && approvalStatus.status !== 'approved') {
            emitPhaseEvent('phase_fail', {
              phase: phaseId,
              stage: 'approval',
              code: 1,
              estimateLog,
              orchestrateLog,
              storyCount,
              provider: config.provider,
              model: config.model,
              defaultModel: config.defaultModel,
              modelSelectionSource: config.modelSelection.source,
              modelSelectionUsedDefault: config.modelSelection.usedDefault,
              message: approvalStatus.status === 'invalidated'
                ? approvalStatus.invalidReason
                : `Phase "${phaseId}" requires human approval before execution.`,
              ...approvalEventPayload(approvalStatus),
            });
            printSummary({
              phase: phaseId,
              storyCount,
              status: 'failed',
              approvalStatus: approvalStatus.status,
              approver: approvalStatus.approver?.displayName ?? approvalStatus.approver?.id,
              approvedAt: approvalStatus.approvedAt,
              estimateLog,
              orchestrateLog,
            });
            process.stderr.write(
              `Error: ${approvalStatus.status === 'invalidated'
                ? approvalStatus.invalidReason
                : `Phase "${phaseId}" requires a valid approval. Run "epam phase approve --phase ${phaseId}" first.`}\n`,
            );
            process.exit(1);
          }

          if (runnableStoryCount === 0) {
            emitPhaseEvent('phase_fail', {
              phase: phaseId,
              stage: 'estimate',
              code: 1,
              estimateLog,
              orchestrateLog,
              storyCount,
              runnableStoryCount,
              provider: config.provider,
              model: config.model,
              defaultModel: config.defaultModel,
              modelSelectionSource: config.modelSelection.source,
              modelSelectionUsedDefault: config.modelSelection.usedDefault,
              message: `Phase "${phaseId}" has no runnable stories. All scoped stories are backlog or completed.`,
              ...approvalEventPayload(approvalStatus),
            });
            printSummary({
              phase: phaseId,
              storyCount,
              status: 'failed',
              approvalStatus: approvalStatus.status,
              approver: approvalStatus.approver?.displayName ?? approvalStatus.approver?.id,
              approvedAt: approvalStatus.approvedAt,
              estimateLog,
              orchestrateLog,
            });
            process.stderr.write(
              `Error: Phase "${phaseId}" has no runnable stories. All scoped stories are backlog or completed.\n`,
            );
            process.exit(1);
          }

          emitPhaseEvent('phase_start', {
            phase: phaseId,
            dryRun: Boolean(opts.dryRun),
            skipCpa: Boolean(opts.skipCpa),
            strictCpa: Boolean(opts.strictCpa),
            requireApproval: Boolean(opts.requireApproval),
            estimateLog,
            orchestrateLog,
            storyCount,
            runnableStoryCount,
            provider: config.provider,
            model: config.model,
            defaultModel: config.defaultModel,
            modelSelectionSource: config.modelSelection.source,
            modelSelectionUsedDefault: config.modelSelection.usedDefault,
            ...approvalEventPayload(approvalStatus),
          });

          const estimateResult = await withModelSelectionEnv(config, async () => executeEstimate({
            phase: phaseId,
            dryRun: opts.dryRun,
            skipCpa: opts.skipCpa,
            strict: opts.strictCpa,
            logFile: estimateLog,
          }));

          if (estimateResult.code !== 0) {
            emitPhaseEvent('phase_fail', {
              phase: phaseId,
              stage: estimateResult.cpa ? 'cpa' : 'estimate',
              code: estimateResult.code,
              estimateLog,
              orchestrateLog,
              storyCount,
              runnableStoryCount,
              provider: config.provider,
              model: config.model,
              defaultModel: config.defaultModel,
              modelSelectionSource: config.modelSelection.source,
              modelSelectionUsedDefault: config.modelSelection.usedDefault,
              message: estimateResult.message,
              ...approvalEventPayload(approvalStatus),
            });
            printSummary({
              phase: phaseId,
              storyCount,
              status: 'failed',
              approvalStatus: approvalStatus.status,
              approver: approvalStatus.approver?.displayName ?? approvalStatus.approver?.id,
              approvedAt: approvalStatus.approvedAt,
              estimateLog,
            });
            process.stderr.write(`Error: ${estimateResult.message ?? 'Estimate phase failed.'}\n`);
            process.exit(estimateResult.code);
          }

          const orchestrateResult = await withModelSelectionEnv(config, async () => executeOrchestrate({
            phase: phaseId,
            dryRun: opts.dryRun,
            skipCpa: true,
            strictCpa: opts.strictCpa,
            logFile: orchestrateLog,
          }));

          if (orchestrateResult.code !== 0) {
            emitPhaseEvent('phase_fail', {
              phase: phaseId,
              stage: 'orchestrate',
              code: orchestrateResult.code,
              estimateLog,
              orchestrateLog,
              storyCount,
              runnableStoryCount,
              provider: config.provider,
              model: config.model,
              defaultModel: config.defaultModel,
              modelSelectionSource: config.modelSelection.source,
              modelSelectionUsedDefault: config.modelSelection.usedDefault,
              message: orchestrateResult.message,
              ...approvalEventPayload(approvalStatus),
            });
            printSummary({
              phase: phaseId,
              storyCount,
              status: 'failed',
              approvalStatus: approvalStatus.status,
              approver: approvalStatus.approver?.displayName ?? approvalStatus.approver?.id,
              approvedAt: approvalStatus.approvedAt,
              estimateLog,
              orchestrateLog,
            });
            process.stderr.write(`Error: ${orchestrateResult.message ?? 'Orchestration failed.'}\n`);
            process.exit(orchestrateResult.code);
          }

          emitPhaseEvent('phase_complete', {
            phase: phaseId,
            code: 0,
            estimateLog,
            orchestrateLog,
            storyCount,
            runnableStoryCount,
            status: 'success',
            provider: config.provider,
            model: config.model,
            defaultModel: config.defaultModel,
            modelSelectionSource: config.modelSelection.source,
            modelSelectionUsedDefault: config.modelSelection.usedDefault,
            ...approvalEventPayload(approvalStatus),
          });
          printSummary({
            phase: phaseId,
            storyCount,
            status: 'success',
            approvalStatus: approvalStatus.status,
            approver: approvalStatus.approver?.displayName ?? approvalStatus.approver?.id,
            approvedAt: approvalStatus.approvedAt,
            estimateLog,
            orchestrateLog,
          });
          process.exit(0);
        } catch (error) {
          process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exit(1);
        }
      }),
  );

  return phase;
}
