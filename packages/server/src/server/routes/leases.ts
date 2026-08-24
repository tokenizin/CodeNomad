// FLWF v2.0 — Lease Management API Routes
// Provides HTTP endpoints for session lease lifecycle

import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Logger } from "../../logger";
import type { LeaseManager } from "../../workspaces/lease-manager";

// ── Validation Schemas ───────────────────────────────────────

const LeaseRegisterSchema = z.object({
  session: z.string().min(1),
  task: z.string().min(1),
  scr: z.string().min(1),
  paths: z.array(z.string()).min(1),
  logic_domains: z.array(z.string()).optional(),
  registry_sections: z.array(z.string()).optional(),
  interface_freeze: z.boolean().optional(),
  ttl_minutes: z.number().positive().optional(),
});

const LeaseReleaseSchema = z.object({
  session: z.string().min(1),
});

const HeartbeatSchema = z.object({
  session: z.string().min(1),
  checkpoint: z.string().min(1),
});

const ConflictCheckSchema = z.object({
  session: z.string().min(1),
  paths: z.array(z.string()).min(1),
  logic_domains: z.array(z.string()).optional(),
});

// ── Route Registration ───────────────────────────────────────

interface LeaseRouteDeps {
  getLeaseManager: () => LeaseManager;
  logger: Logger;
}

export function registerLeaseRoutes(app: FastifyInstance, deps: LeaseRouteDeps) {
  const { getLeaseManager, logger } = deps;

  /**
   * POST /api/leases — Register a new lease
   */
  app.post("/api/leases", async (request, reply) => {
    const body = LeaseRegisterSchema.parse(request.body ?? {});
    const manager = getLeaseManager();

    try {
      const lease = manager.register({
        session: body.session,
        task: body.task,
        scr: body.scr,
        paths: body.paths,
        logic_domains: body.logic_domains,
        registry_sections: body.registry_sections,
        interface_freeze: body.interface_freeze,
        ttl_minutes: body.ttl_minutes,
      });

      reply.code(201).send({ ok: true, lease });
    } catch (error) {
      logger.error({ err: error, body }, "Failed to register lease");
      reply.code(500).send({ error: "Failed to register lease" });
    }
  });

  /**
   * DELETE /api/leases/:session — Release all leases for a session
   */
  app.delete("/api/leases/:session", async (request, reply) => {
    const { session } = request.params as { session: string };
    const manager = getLeaseManager();

    try {
      const count = manager.releaseAll(session);
      reply.send({ ok: true, released: count });
    } catch (error) {
      logger.error({ err: error, session }, "Failed to release leases");
      reply.code(500).send({ error: "Failed to release leases" });
    }
  });

  /**
   * POST /api/leases/heartbeat — Refresh session heartbeat
   */
  app.post("/api/leases/heartbeat", async (request, reply) => {
    const body = HeartbeatSchema.parse(request.body ?? {});
    const manager = getLeaseManager();

    try {
      const ok = manager.refreshHeartbeat(body.session, body.checkpoint);
      if (!ok) {
        reply.code(404).send({ error: "No active lease found for session" });
        return;
      }
      reply.send({ ok: true });
    } catch (error) {
      logger.error({ err: error, body }, "Failed to refresh heartbeat");
      reply.code(500).send({ error: "Failed to refresh heartbeat" });
    }
  });

  /**
   * POST /api/leases/conflicts — Check for conflicts
   */
  app.post("/api/leases/conflicts", async (request, reply) => {
    const body = ConflictCheckSchema.parse(request.body ?? {});
    const manager = getLeaseManager();

    try {
      const conflicts = manager.detectConflicts(
        body.paths,
        body.logic_domains ?? [],
        body.session
      );
      reply.send({ ok: true, conflicts });
    } catch (error) {
      logger.error({ err: error, body }, "Failed to detect conflicts");
      reply.code(500).send({ error: "Failed to detect conflicts" });
    }
  });

  /**
   * GET /api/leases — List all active leases
   */
  app.get("/api/leases", async (_request, reply) => {
    const manager = getLeaseManager();

    try {
      const leases = manager.getActiveLeases();
      reply.send({ ok: true, leases });
    } catch (error) {
      logger.error({ err: error }, "Failed to list leases");
      reply.code(500).send({ error: "Failed to list leases" });
    }
  });
}
