import path from 'path';
import fs from 'fs/promises';
import { ulid } from 'ulid';
import { appendLine, readLines, ensureDir, pathExists } from '../utils/fs.js';
import { getEpamGlobalDir } from '../utils/platform.js';
import type { Session, SessionTurn, ForkMetadata } from './types.js';

export function getSessionsDir(projectRoot: string | null): string {
  if (projectRoot) {
    return path.join(projectRoot, '.epam', 'sessions');
  }
  return path.join(getEpamGlobalDir(), 'sessions');
}

export function createSession(
  projectRoot: string | null,
  model: string,
  provider: string
): Session {
  return {
    id: ulid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectRoot,
    model,
    provider,
    turns: [],
  };
}

export async function appendTurn(session: Session, turn: SessionTurn): Promise<void> {
  const sessionsDir = getSessionsDir(session.projectRoot);
  await ensureDir(sessionsDir);
  const filePath = path.join(sessionsDir, `${session.id}.jsonl`);
  session.turns.push(turn);
  session.updatedAt = Date.now();
  await appendLine(filePath, turn);
}

export function createTurn(
  userMessage: string,
  assistantResponse: string,
  toolCallCount: number,
  usage: { inputTokens: number; outputTokens: number }
): SessionTurn {
  return {
    id: ulid(),
    timestamp: Date.now(),
    userMessage,
    assistantResponse,
    toolCallCount,
    usage,
  };
}

export async function loadSession(
  sessionId: string,
  projectRoot: string | null
): Promise<Session | null> {
  const sessionsDir = getSessionsDir(projectRoot);
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

  if (!(await pathExists(filePath))) {
    // Also check global sessions dir if not found locally
    const globalPath = path.join(getEpamGlobalDir(), 'sessions', `${sessionId}.jsonl`);
    if (!(await pathExists(globalPath))) return null;
    return loadSessionFile(globalPath, sessionId, null);
  }

  return loadSessionFile(filePath, sessionId, projectRoot);
}

// Alias for loadSession — same contract, friendlier name for callers
export const getSession = loadSession;

export async function saveSession(session: Session): Promise<void> {
  const sessionsDir = getSessionsDir(session.projectRoot);
  await ensureDir(sessionsDir);
  const filePath = path.join(sessionsDir, `${session.id}.jsonl`);
  const lines = session.turns.map(t => JSON.stringify(t)).join('\n');
  await fs.writeFile(filePath, lines ? lines + '\n' : '', 'utf-8');
}

export async function forkSession(
  original: Session,
  label?: string
): Promise<{ newSessionId: string; originSessionId: string }> {
  const newSessionId = ulid();
  const sessionsDir = getSessionsDir(original.projectRoot);
  await ensureDir(sessionsDir);
  const filePath = path.join(sessionsDir, `${newSessionId}.jsonl`);

  const forkMeta: ForkMetadata = {
    type: 'fork_metadata',
    timestamp: Date.now(),
    originSessionId: original.id,
    ...(label !== undefined ? { label } : {}),
  };

  const forkedTurns = original.turns.map(t => ({
    ...JSON.parse(JSON.stringify(t)) as SessionTurn,
    id: ulid(),
  }));

  const allLines = [forkMeta, ...forkedTurns].map(o => JSON.stringify(o)).join('\n');
  await fs.writeFile(filePath, allLines + '\n', 'utf-8');

  return { newSessionId, originSessionId: original.id };
}

async function loadSessionFile(
  filePath: string,
  sessionId: string,
  projectRoot: string | null
): Promise<Session> {
  const lines = await readLines(filePath);
  const turns: SessionTurn[] = lines
    .map(line => {
      try {
        return JSON.parse(line) as SessionTurn;
      } catch {
        return null;
      }
    })
    .filter((t): t is SessionTurn => t !== null);

  const stat = await fs.stat(filePath);

  return {
    id: sessionId,
    createdAt: stat.birthtimeMs,
    updatedAt: stat.mtimeMs,
    projectRoot,
    model: '',    // not stored in JSONL — caller fills in if needed
    provider: '',
    turns,
  };
}

export interface SessionSummary {
  id: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  turnCount: number;
  createdAt: Date;
  updatedAt: Date;
  path: string;
  client?: string;
  isFork: boolean;
  label?: string;
  originSessionId?: string;
}

export async function listSessions(
  projectRoot: string | null,
  limit = 20
): Promise<SessionSummary[]> {
  const dirs = [getSessionsDir(projectRoot)];
  // Also include global sessions if project-local differs
  const globalDir = path.join(getEpamGlobalDir(), 'sessions');
  if (!dirs.includes(globalDir)) dirs.push(globalDir);

  const results: SessionSummary[] = [];

  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    const files = await fs.readdir(dir);
    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      const lines = await readLines(filePath);

      let isFork = false;
      let label: string | undefined;
      let originSessionId: string | undefined;

      if (lines.length > 0) {
        try {
          const first = JSON.parse(lines[0]) as Partial<ForkMetadata>;
          if (first.type === 'fork_metadata') {
            isFork = true;
            label = first.label;
            originSessionId = first.originSessionId;
          }
        } catch {
          // not JSON or not fork metadata — treat as normal session
        }
      }

      const turnLines = isFork ? lines.slice(1) : lines;

      results.push({
        id: file.replace('.jsonl', ''),
        model: '',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        turnCount: turnLines.length,
        createdAt: new Date(stat.birthtimeMs),
        updatedAt: stat.mtime,
        path: filePath,
        isFork,
        ...(label !== undefined ? { label } : {}),
        ...(originSessionId !== undefined ? { originSessionId } : {}),
      });
    }
  }

  return results
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit);
}
