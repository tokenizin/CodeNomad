// FLWF v2.0 — File-Lease & Work-Forward Protocol
// Phase 1: Lease System + Pre-Write Guard

import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────

export type LeaseState = "ACTIVE" | "EXPIRED" | "STOLEN" | "RELEASED";

export type ConflictClass = "FREE" | "FORWARD" | "PROCEED-WITH-NOTE" | "PROCEED-WITH-CONTRACT";

export interface Lease {
  id: string;
  session: string;
  task: string;
  scr: string;
  paths: string[];
  logic_domains: string[];
  registry_sections: string[];
  interface_freeze: boolean;
  ttl_minutes: number;
  heartbeat: {
    at: string;
    checkpoint: string;
  };
  state: LeaseState;
  stolen_by?: string;
  stolen_at?: string;
  arbitration?: {
    reason: string;
    decided_by: string;
    decided_at: string;
  };
}

export interface Conflict {
  class: ConflictClass;
  path: string;
  holder?: string;
  leaseId?: string;
  reason: string;
}

export interface WriteDecision {
  action: "PROCEED" | "BLOCK" | "FORWARD";
  reason?: string;
  to_session?: string;
  conflicts?: Conflict[];
}

export interface LeaseRegisterParams {
  session: string;
  task: string;
  scr: string;
  paths: string[];
  logic_domains?: string[];
  registry_sections?: string[];
  interface_freeze?: boolean;
  ttl_minutes?: number;
}

// ─── Lease Schema (v1) ───────────────────────────────────────

const LEASES_FILENAME = ".nomadworks/leases.json";

function getLeasesPath(repoRoot: string): string {
  return path.join(repoRoot, LEASES_FILENAME);
}

// ─── LeaseManager ────────────────────────────────────────────

export class LeaseManager {
  private leases: Lease[] = [];
  private repoRoot: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly defaultTtlMinutes = 60;
  private readonly reaperIntervalMs = 60_000; // 1 minute

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.load();
    this.startHeartbeatReaper();
  }

  // ─── Persistence ───────────────────────────────────────────

  private load(): void {
    const filePath = getLeasesPath(this.repoRoot);
    try {
      if (!fs.existsSync(filePath)) {
        this.leases = [];
        return;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.leases = [];
        return;
      }
      this.leases = parsed.filter(isValidLease);
    } catch (error) {
      console.error("[LeaseManager] Failed to load leases:", error);
      this.leases = [];
    }
  }

  private save(): void {
    const filePath = getLeasesPath(this.repoRoot);
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Atomic write: write to temp then rename
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.leases, null, 2), "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      console.error("[LeaseManager] Failed to save leases:", error);
    }
  }

  // ─── Registration ──────────────────────────────────────────

  register(params: LeaseRegisterParams): Lease {
    const now = new Date().toISOString();
    const lease: Lease = {
      id: generateLeaseId(),
      session: params.session,
      task: params.task,
      scr: params.scr,
      paths: [...params.paths],
      logic_domains: params.logic_domains ?? [],
      registry_sections: params.registry_sections ?? [],
      interface_freeze: params.interface_freeze ?? false,
      ttl_minutes: params.ttl_minutes ?? this.defaultTtlMinutes,
      heartbeat: {
        at: now,
        checkpoint: "init",
      },
      state: "ACTIVE",
    };

    this.leases.push(lease);
    this.save();

    console.log(`[LeaseManager] Registered lease ${lease.id} for session ${params.session}, paths: ${params.paths.join(", ")}`);
    return lease;
  }

  // ─── Release ───────────────────────────────────────────────

  release(leaseId: string): boolean {
    const lease = this.findLease(leaseId);
    if (!lease) return false;

    lease.state = "RELEASED";
    this.save();

    console.log(`[LeaseManager] Released lease ${leaseId}`);
    return true;
  }

  releaseAll(sessionId: string): number {
    let count = 0;
    for (const lease of this.leases) {
      if (lease.session === sessionId && lease.state === "ACTIVE") {
        lease.state = "RELEASED";
        count++;
      }
    }
    if (count > 0) {
      this.save();
      console.log(`[LeaseManager] Released ${count} leases for session ${sessionId}`);
    }
    return count;
  }

  // ─── Reclaim (stale lease) ─────────────────────────────────

  reclaim(leaseId: string, sessionId: string): Lease | null {
    const lease = this.findLease(leaseId);
    if (!lease) return null;
    if (lease.state !== "EXPIRED") return null;

    const now = new Date().toISOString();

    // Mark old lease as STOLEN (provenance preserved)
    lease.state = "STOLEN";
    lease.stolen_by = sessionId;
    lease.stolen_at = now;

    // Create new lease for reclaimer
    const newLease: Lease = {
      id: generateLeaseId(),
      session: sessionId,
      task: lease.task,
      scr: lease.scr,
      paths: [...lease.paths],
      logic_domains: [...lease.logic_domains],
      registry_sections: [...lease.registry_sections],
      interface_freeze: lease.interface_freeze,
      ttl_minutes: lease.ttl_minutes,
      heartbeat: {
        at: now,
        checkpoint: "reclaim",
      },
      state: "ACTIVE",
    };

    this.leases.push(newLease);
    this.save();

    console.log(`[LeaseManager] Reclaimed lease ${leaseId} from ${lease.session} to ${sessionId}`);
    return newLease;
  }

  // ─── Heartbeat ─────────────────────────────────────────────

  refreshHeartbeat(sessionId: string, checkpoint: string): boolean {
    const lease = this.findActiveLease(sessionId);
    if (!lease) return false;

    lease.heartbeat = {
      at: new Date().toISOString(),
      checkpoint,
    };
    this.save();
    return true;
  }

  // ─── Conflict Detection ────────────────────────────────────

  detectConflicts(paths: string[], logicDomains: string[], excludeSessionId?: string): Conflict[] {
    const conflicts: Conflict[] = [];
    const activeLeases = this.leases.filter(
      (l) => l.state === "ACTIVE" && l.session !== excludeSessionId
    );

    for (const targetPath of paths) {
      for (const lease of activeLeases) {
        // 1. Exact-path match
        const exactMatch = lease.paths.some((p) => p === targetPath);
        if (exactMatch) {
          conflicts.push({
            class: "FORWARD",
            path: targetPath,
            holder: lease.session,
            leaseId: lease.id,
            reason: `Exact-path match: ${targetPath} is leased by ${lease.session}`,
          });
          continue;
        }

        // 2. Glob/dir containment
        const globMatch = lease.paths.some((p) => matchesGlob(p, targetPath));
        if (globMatch) {
          conflicts.push({
            class: "PROCEED-WITH-NOTE",
            path: targetPath,
            holder: lease.session,
            leaseId: lease.id,
            reason: `Glob/dir overlap: ${targetPath} matches ${lease.paths.find((p) => matchesGlob(p, targetPath))} leased by ${lease.session}`,
          });
          continue;
        }

        // 3. Logic-domain adjacency
        const domainMatch = logicDomains.some((d) => lease.logic_domains.includes(d));
        if (domainMatch) {
          conflicts.push({
            class: lease.interface_freeze ? "FORWARD" : "PROCEED-WITH-CONTRACT",
            path: targetPath,
            holder: lease.session,
            leaseId: lease.id,
            reason: `Logic-domain adjacency: ${logicDomains.find((d) => lease.logic_domains.includes(d))} shared with ${lease.session}${lease.interface_freeze ? " (interface_frozen)" : ""}`,
          });
        }
      }
    }

    return conflicts;
  }

  // ─── Pre-Write Guard ───────────────────────────────────────

  checkWrite(sessionId: string, filePath: string): WriteDecision {
    const activeLeases = this.leases.filter((l) => l.state === "ACTIVE");

    // Check if session holds a lease covering this path
    const ownLease = activeLeases.find(
      (l) => l.session === sessionId && l.paths.some((p) => matchesPath(p, filePath))
    );

    if (ownLease) {
      // Session holds the lease — refresh heartbeat and proceed
      this.refreshHeartbeat(sessionId, "write");
      return { action: "PROCEED" };
    }

    // Check if another session holds this path
    const holder = activeLeases.find((l) =>
      l.paths.some((p) => matchesPath(p, filePath))
    );

    if (holder) {
      return {
        action: "FORWARD",
        reason: `File ${filePath} is leased by session ${holder.session}`,
        to_session: holder.session,
        conflicts: [{
          class: "FORWARD",
          path: filePath,
          holder: holder.session,
          leaseId: holder.id,
          reason: `Path leased by ${holder.session}`,
        }],
      };
    }

    // No lease found — allow but warn (unclaimed path)
    return { action: "PROCEED" };
  }

  // ─── Queries ───────────────────────────────────────────────

  findLease(leaseId: string): Lease | undefined {
    return this.leases.find((l) => l.id === leaseId);
  }

  findActiveLease(sessionId: string): Lease | undefined {
    return this.leases.find((l) => l.session === sessionId && l.state === "ACTIVE");
  }

  getActiveLeases(): Lease[] {
    return this.leases.filter((l) => l.state === "ACTIVE");
  }

  getExpiredLeases(): Lease[] {
    const now = Date.now();
    return this.leases.filter((l) => {
      if (l.state !== "ACTIVE") return false;
      const lastBeat = new Date(l.heartbeat.at).getTime();
      return now - lastBeat > l.ttl_minutes * 60_000;
    });
  }

  getAllLeases(): Lease[] {
    return [...this.leases];
  }

  // ─── Heartbeat Reaper ──────────────────────────────────────

  private startHeartbeatReaper(): void {
    this.heartbeatTimer = setInterval(() => {
      this.reapStaleLeases();
    }, this.reaperIntervalMs);
    this.heartbeatTimer.unref();
  }

  private reapStaleLeases(): void {
    const expired = this.getExpiredLeases();
    for (const lease of expired) {
      lease.state = "EXPIRED";
      console.log(`[LeaseManager] Lease ${lease.id} (session ${lease.session}) expired — stale heartbeat`);
    }
    if (expired.length > 0) {
      this.save();
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function generateLeaseId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `LSE-${timestamp}-${random}`;
}

function isValidLease(obj: unknown): obj is Lease {
  if (!obj || typeof obj !== "object") return false;
  const l = obj as Record<string, unknown>;
  return (
    typeof l.id === "string" &&
    typeof l.session === "string" &&
    typeof l.task === "string" &&
    Array.isArray(l.paths) &&
    typeof l.state === "string" &&
    l.heartbeat !== undefined
  );
}

function matchesPath(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  // Glob matching: treat * as wildcard
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(target);
  }
  return false;
}

function matchesGlob(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  // Directory containment: pattern is a directory prefix
  if (target.startsWith(pattern + "/")) return true;
  // Glob wildcard
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(target);
  }
  return false;
}
