import type { AuthManager } from '../auth/AuthManager.js';
import type { ResolvedConfig } from '../config/types.js';
import { buildSystemPrompt } from '../context/ContextBuilder.js';
import { BackendClient } from '../http/BackendClient.js';
import type { Constraint } from './types.js';
import { ConstraintLoader } from './ConstraintLoader.js';

export function getProjectId(projectRoot: string): string {
  return Buffer.from(projectRoot).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

export async function buildSessionSystemPrompt(
  config: Pick<ResolvedConfig, 'backendUrl' | 'contextFile' | 'systemPromptFile' | 'projectRoot'>,
  authManager: AuthManager
): Promise<string> {
  let blockConstraints: Constraint[] = [];
  let warnConstraints: Constraint[] = [];

  if (config.projectRoot) {
    const backendClient = new BackendClient(config.backendUrl, authManager);
    const constraintLoader = new ConstraintLoader(backendClient);
    const constraints = await constraintLoader.loadConstraints(getProjectId(config.projectRoot));
    const separated = constraintLoader.separateConstraintsBySeverity(constraints);
    blockConstraints = separated.block;
    warnConstraints = separated.warn;
  }

  return buildSystemPrompt({
    contextFilePath: config.contextFile,
    systemPromptFile: config.systemPromptFile,
    projectRoot: config.projectRoot,
    blockConstraints,
    warnConstraints,
  });
}
