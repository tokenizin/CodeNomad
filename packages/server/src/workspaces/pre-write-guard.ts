// FLWF v2.0 — Pre-Write Guard
// Checks lease ownership before allowing file writes

import { LeaseManager, WriteDecision } from "./lease-manager";

export class PreWriteGuard {
  private leaseManager: LeaseManager;

  constructor(leaseManager: LeaseManager) {
    this.leaseManager = leaseManager;
  }

  /**
   * Check if a session can write to a file.
   * Returns PROCEED, BLOCK, or FORWARD decision.
   */
  check(sessionId: string, filePath: string): WriteDecision {
    return this.leaseManager.checkWrite(sessionId, filePath);
  }

  /**
   * Check if a session can write to multiple files.
   * Returns the most restrictive decision.
   */
  checkMany(sessionId: string, filePaths: string[]): WriteDecision {
    const decisions = filePaths.map((p) => this.check(sessionId, p));
    
    // Most restrictive first: BLOCK > FORWARD > PROCEED
    if (decisions.some((d) => d.action === "BLOCK")) {
      return decisions.find((d) => d.action === "BLOCK")!;
    }
    if (decisions.some((d) => d.action === "FORWARD")) {
      return decisions.find((d) => d.action === "FORWARD")!;
    }
    return { action: "PROCEED" };
  }

  /**
   * Detect conflicts for a set of paths and logic domains.
   */
  detectConflicts(
    sessionId: string,
    paths: string[],
    logicDomains: string[]
  ) {
    return this.leaseManager.detectConflicts(paths, logicDomains, sessionId);
  }

  /**
   * Register a new lease for a session.
   */
  register(params: {
    session: string;
    task: string;
    scr: string;
    paths: string[];
    logic_domains?: string[];
    registry_sections?: string[];
    interface_freeze?: boolean;
    ttl_minutes?: number;
  }) {
    return this.leaseManager.register(params);
  }

  /**
   * Release all leases for a session.
   */
  releaseAll(sessionId: string): number {
    return this.leaseManager.releaseAll(sessionId);
  }

  /**
   * Refresh heartbeat for a session.
   */
  refreshHeartbeat(sessionId: string, checkpoint: string): boolean {
    return this.leaseManager.refreshHeartbeat(sessionId, checkpoint);
  }

  /**
   * Get the underlying LeaseManager.
   */
  getLeaseManager(): LeaseManager {
    return this.leaseManager;
  }
}
