import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

export interface PhaseEstimateTotals {
  minutes: number;
  cost: number;
  tokens: number;
  turns: number;
}

export interface PhaseStoryApprovalSnapshot {
  id: string;
  title: string;
  estimatedMinutes: number;
  estimatedCost: number;
  estimatedTokens: number;
  estimatedTurns: number;
}

export interface PhaseApprovalSnapshot {
  phaseId: string;
  phaseName: string;
  storyIds: string[];
  storyFingerprint: string;
  stories: PhaseStoryApprovalSnapshot[];
  estimates: PhaseEstimateTotals;
}

export interface PhaseApproverIdentity {
  id: string;
  displayName: string;
  source: string;
}

export interface PhaseApprovalRecord {
  schemaVersion: 1;
  recordType: 'phase_approval';
  approvalStatus: 'approved';
  phaseId: string;
  phaseName: string;
  approvedAt: string;
  approver: PhaseApproverIdentity;
  storyCount: number;
  storyIds: string[];
  storyFingerprint: string;
  estimates: PhaseEstimateTotals;
  stories: PhaseStoryApprovalSnapshot[];
}

export interface PhaseApprovalStatus {
  phaseId: string;
  phaseName: string;
  status: 'approved' | 'missing' | 'invalidated';
  storyCount: number;
  approvedAt?: string;
  approver?: PhaseApproverIdentity;
  invalidReason?: string;
  record?: PhaseApprovalRecord;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isApprovalRecord(value: unknown): value is PhaseApprovalRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.recordType === 'phase_approval'
    && record.approvalStatus === 'approved'
    && typeof record.phaseId === 'string'
    && typeof record.phaseName === 'string'
    && typeof record.approvedAt === 'string'
    && typeof record.storyFingerprint === 'string'
    && Array.isArray(record.storyIds)
    && Array.isArray(record.stories)
    && typeof record.approver === 'object'
    && record.approver !== null;
}

function diffStoryIds(previous: string[], current: string[]): string {
  const removed = previous.filter(id => !current.includes(id));
  const added = current.filter(id => !previous.includes(id));
  const changes: string[] = [];

  if (added.length > 0) {
    changes.push(`added: ${added.join(', ')}`);
  }
  if (removed.length > 0) {
    changes.push(`removed: ${removed.join(', ')}`);
  }

  return changes.length > 0 ? changes.join('; ') : 'phase story set no longer matches the approved snapshot';
}

export const DEFAULT_PHASE_APPROVAL_LOG_PATH = resolve(
  process.cwd(),
  'orchestrations/logs/phase-approvals.jsonl',
);

export class PhaseApprovalStore {
  constructor(
    private readonly logPath: string = DEFAULT_PHASE_APPROVAL_LOG_PATH,
  ) {}

  getLogPath(): string {
    return this.logPath;
  }

  appendApproval(snapshot: PhaseApprovalSnapshot, approver: PhaseApproverIdentity): PhaseApprovalRecord {
    const record: PhaseApprovalRecord = {
      schemaVersion: 1,
      recordType: 'phase_approval',
      approvalStatus: 'approved',
      phaseId: snapshot.phaseId,
      phaseName: snapshot.phaseName,
      approvedAt: new Date().toISOString(),
      approver,
      storyCount: snapshot.storyIds.length,
      storyIds: [...snapshot.storyIds],
      storyFingerprint: snapshot.storyFingerprint,
      estimates: {
        minutes: asNumber(snapshot.estimates.minutes),
        cost: asNumber(snapshot.estimates.cost),
        tokens: asNumber(snapshot.estimates.tokens),
        turns: asNumber(snapshot.estimates.turns),
      },
      stories: snapshot.stories.map(story => ({
        id: story.id,
        title: story.title,
        estimatedMinutes: asNumber(story.estimatedMinutes),
        estimatedCost: asNumber(story.estimatedCost),
        estimatedTokens: asNumber(story.estimatedTokens),
        estimatedTurns: asNumber(story.estimatedTurns),
      })),
    };

    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  getApprovalStatus(snapshot: PhaseApprovalSnapshot): PhaseApprovalStatus {
    const record = this.readLatestApproval(snapshot.phaseId);
    if (!record) {
      return {
        phaseId: snapshot.phaseId,
        phaseName: snapshot.phaseName,
        status: 'missing',
        storyCount: snapshot.storyIds.length,
      };
    }

    if (record.storyFingerprint !== snapshot.storyFingerprint) {
      return {
        phaseId: snapshot.phaseId,
        phaseName: snapshot.phaseName,
        status: 'invalidated',
        storyCount: snapshot.storyIds.length,
        approvedAt: record.approvedAt,
        approver: record.approver,
        invalidReason: `Approved on ${record.approvedAt}, but the phase story set changed (${diffStoryIds(record.storyIds, snapshot.storyIds)}).`,
        record,
      };
    }

    return {
      phaseId: snapshot.phaseId,
      phaseName: snapshot.phaseName,
      status: 'approved',
      storyCount: snapshot.storyIds.length,
      approvedAt: record.approvedAt,
      approver: record.approver,
      record,
    };
  }

  private readLatestApproval(phaseId: string): PhaseApprovalRecord | undefined {
    const records = this.readRecords();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index]?.phaseId === phaseId) {
        return records[index];
      }
    }
    return undefined;
  }

  private readRecords(): PhaseApprovalRecord[] {
    if (!existsSync(this.logPath)) {
      return [];
    }

    const content = readFileSync(this.logPath, 'utf8');
    if (content.trim().length === 0) {
      return [];
    }

    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .flatMap(line => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isApprovalRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  }
}
