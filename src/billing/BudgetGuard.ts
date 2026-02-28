import type { BudgetGuardrails } from '../config/types.js';
import { calculateCost, formatCost } from './pricing.js';
import { logger } from '../utils/logger.js';

export type BudgetAction = 'ok' | 'warning' | 'downgrade' | 'pause';

export interface BudgetCheckResult {
  action: BudgetAction;
  sessionCost: number;
  warningAt: number;
  hardLimitAt: number;
  /** Human-readable message for the REPL to display. Empty when action is 'ok'. */
  message: string;
}

export class BudgetGuard {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private model: string;
  private warningEmitted = false;

  constructor(
    private guardrails: BudgetGuardrails,
    initialModel: string,
  ) {
    this.model = initialModel;
  }

  get sessionCost(): number {
    return calculateCost(this.model, this.totalInputTokens, this.totalOutputTokens);
  }

  get inputTokens(): number {
    return this.totalInputTokens;
  }

  get outputTokens(): number {
    return this.totalOutputTokens;
  }

  get limits(): { warningAt: number; hardLimitAt: number } {
    return {
      warningAt: this.guardrails.warningAt,
      hardLimitAt: this.guardrails.hardLimitAt,
    };
  }

  get hasLimits(): boolean {
    return isFinite(this.guardrails.warningAt) || isFinite(this.guardrails.hardLimitAt);
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** Load prior token counts (e.g. when resuming a session). */
  loadTokens(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens = inputTokens;
    this.totalOutputTokens = outputTokens;
    this.warningEmitted = false;
  }

  /**
   * Record tokens from a completed LLM response and check budget thresholds.
   * Called after each provider response inside the agent loop.
   */
  recordUsage(inputTokens: number, outputTokens: number): BudgetCheckResult {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;

    const cost = this.sessionCost;
    const { warningAt, hardLimitAt } = this.guardrails;

    if (isFinite(hardLimitAt) && cost >= hardLimitAt) {
      const action = this.guardrails.onHardLimit;
      const remaining = formatCost(0);
      logger.warn({ cost, hardLimitAt, action }, 'Budget hard limit reached');
      return {
        action,
        sessionCost: cost,
        warningAt,
        hardLimitAt,
        message: action === 'downgrade'
          ? `Budget limit ${formatCost(hardLimitAt)} reached (session: ${formatCost(cost)}). Auto-downgrading to cheaper model.`
          : `Budget limit ${formatCost(hardLimitAt)} reached (session: ${formatCost(cost)}). Pausing — approve to continue.`,
      };
    }

    if (isFinite(warningAt) && cost >= warningAt && !this.warningEmitted) {
      this.warningEmitted = true;
      const remaining = isFinite(hardLimitAt) ? formatCost(hardLimitAt - cost) : 'no hard limit';
      logger.info({ cost, warningAt }, 'Budget warning threshold crossed');
      return {
        action: 'warning',
        sessionCost: cost,
        warningAt,
        hardLimitAt,
        message: `Session cost ${formatCost(cost)} has passed warning threshold ${formatCost(warningAt)}. Remaining before hard limit: ${remaining}.`,
      };
    }

    return {
      action: 'ok',
      sessionCost: cost,
      warningAt,
      hardLimitAt,
      message: '',
    };
  }

  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.warningEmitted = false;
  }
}
