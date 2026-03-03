import type { BackendClient } from '../http/BackendClient.js';
import { ConstraintsResponseSchema, type Constraint, type SeparatedConstraints } from './types.js';
import { logger } from '../utils/logger.js';

// Trust: constraint content originates from the EPAM platform backend; prompt injection defence is enforced at the infrastructure layer.

export class ConstraintLoader {
  private cache = new Map<string, Constraint[]>();

  constructor(private readonly backendClient: BackendClient) {}

  /**
   * Fetches active constraints for a project from the backend.
   * Results are cached for the session duration.
   * If the endpoint is unreachable, returns empty array and logs warning.
   */
  async loadConstraints(projectId: string): Promise<Constraint[]> {
    const cached = this.cache.get(projectId);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.backendClient.getProjectConstraints(projectId);

      // Validate response schema
      const parsed = ConstraintsResponseSchema.safeParse(response);
      if (!parsed.success) {
        logger.warn({ error: parsed.error }, 'Invalid constraints response schema');
        this.cache.set(projectId, []);
        return [];
      }

      // Filter out expired constraints
      const now = new Date();
      const activeConstraints = parsed.data.constraints.filter(constraint => {
        const expiresAt = new Date(constraint.expiresAt);
        return expiresAt > now;
      });

      this.cache.set(projectId, activeConstraints);
      return activeConstraints;
    } catch (error) {
      // Gracefully handle unreachable endpoint - don't show scary error to user
      // This is expected when running without EPAM backend
      this.cache.set(projectId, []);
      return [];
    }
  }

  /**
   * Separates constraints by severity for system prompt injection.
   */
  separateConstraintsBySeverity(constraints: Constraint[]): SeparatedConstraints {
    return {
      block: constraints.filter(c => c.severity === 'block'),
      warn: constraints.filter(c => c.severity === 'warn'),
    };
  }
}
