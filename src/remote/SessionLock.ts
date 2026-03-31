/**
 * SessionLock manages the active remote session state
 * Ensures only one remote session can be active at a time
 * Lock is stored in memory only (not persisted to disk)
 */

interface LockState {
  claimToken: string;
  acquiredAt: number;
  ttlSeconds: number;
}

class SessionLockManager {
  private lock: LockState | null = null;

  /**
   * Acquire a lock for a new remote session
   * Returns false if a lock is already active
   */
  acquire(claimToken: string, ttlSeconds: number): boolean {
    if (this.lock !== null) {
      return false;
    }

    this.lock = {
      claimToken,
      acquiredAt: Date.now(),
      ttlSeconds,
    };

    return true;
  }

  /**
   * Release the active lock
   * Returns true if a lock was released, false if no lock was active
   */
  release(): boolean {
    if (this.lock === null) {
      return false;
    }

    this.lock = null;
    return true;
  }

  /**
   * Force-release the lock (used during reclaim)
   */
  forceRelease(): void {
    this.lock = null;
  }

  /**
   * Check if a lock is currently active
   */
  isLocked(): boolean {
    return this.lock !== null;
  }

  /**
   * Get the active lock state
   * Returns null if no lock is active
   */
  getState(): LockState | null {
    return this.lock;
  }

  /**
   * Get the remaining TTL in seconds
   * Returns 0 if no lock is active or TTL has expired
   */
  getRemainingTTL(): number {
    if (this.lock === null) {
      return 0;
    }

    const elapsedMs = Date.now() - this.lock.acquiredAt;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const remaining = this.lock.ttlSeconds - elapsedSeconds;

    return Math.max(0, remaining);
  }

  /**
   * Get the claim token of the active lock
   * Returns null if no lock is active
   */
  getClaimToken(): string | null {
    return this.lock?.claimToken ?? null;
  }
}

// Singleton instance
export const SessionLock = new SessionLockManager();
