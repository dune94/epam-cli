import type { ProviderSlot, HealthRecord, HealthStatus } from './types.js';
import { cooldownForDecision } from './FailoverPolicy.js';

function slotKey(slot: ProviderSlot): string {
  return `${slot.provider}/${slot.model}`;
}

export class ProviderHealth {
  private records = new Map<string, HealthRecord>();

  constructor(slots: ProviderSlot[]) {
    for (const slot of slots) {
      this.records.set(slotKey(slot), {
        slot,
        status: 'healthy',
        failureCount: 0,
        lastFailureAt: null,
        lastError: null,
        cooldownMs: 0,
      });
    }
  }

  getRecord(slot: ProviderSlot): HealthRecord {
    const key = slotKey(slot);
    if (!this.records.has(key)) {
      this.records.set(key, {
        slot,
        status: 'healthy',
        failureCount: 0,
        lastFailureAt: null,
        lastError: null,
        cooldownMs: 0,
      });
    }
    return this.records.get(key)!;
  }

  isAvailable(slot: ProviderSlot): boolean {
    const rec = this.getRecord(slot);
    if (rec.status === 'unavailable') return false;
    if (rec.status === 'down') {
      // Check if cooldown has expired
      if (rec.lastFailureAt != null && Date.now() - rec.lastFailureAt >= rec.cooldownMs) {
        rec.status = 'healthy';
        rec.failureCount = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  recordFailure(slot: ProviderSlot, error: string, statusCode?: number): void {
    const rec = this.getRecord(slot);
    rec.failureCount++;
    rec.lastFailureAt = Date.now();
    rec.lastError = error;
    rec.cooldownMs = cooldownForDecision(statusCode);

    if (rec.failureCount >= 2 || rec.status === 'degraded') {
      rec.status = 'down';
    } else {
      rec.status = 'degraded';
    }
  }

  markHealthy(slot: ProviderSlot): void {
    const rec = this.getRecord(slot);
    rec.status = 'healthy';
    rec.failureCount = 0;
    rec.lastError = null;
    rec.lastFailureAt = null;
  }

  markUnavailable(slot: ProviderSlot, reason: string): void {
    const rec = this.getRecord(slot);
    rec.status = 'unavailable';
    rec.lastError = reason;
  }

  resetAll(): void {
    for (const rec of this.records.values()) {
      if (rec.status !== 'unavailable') {
        rec.status = 'healthy';
        rec.failureCount = 0;
        rec.lastError = null;
        rec.lastFailureAt = null;
      }
    }
  }

  getStatus(slot: ProviderSlot): HealthStatus {
    return this.getRecord(slot).status;
  }

  cooldownRemainingMs(slot: ProviderSlot): number {
    const rec = this.getRecord(slot);
    if (rec.status !== 'down' || rec.lastFailureAt == null) return 0;
    return Math.max(0, rec.cooldownMs - (Date.now() - rec.lastFailureAt));
  }

  allRecords(): HealthRecord[] {
    return Array.from(this.records.values());
  }
}
