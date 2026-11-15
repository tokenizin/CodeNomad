/**
 * Git Graph routes — serve the embedded Git Graph view for a CodeNomad
 * workspace (see packages/server/src/gitgraph/bridge.ts for the engine).
 *
 * URL surface (all behind the CodeNomad session gate via isGitGraphPath):
 *   GET  /gitgraph/:id/            HTML page (optionally ?worktree=<slug>)
 *   GET  /gitgraph/:id/media/:file webview assets (out.min.js/css, fonts)
 *   GET  /gitgraph/:id/__events    SSE stream (extension → webview messages)
 *   POST /gitgraph/:id/__request   webview → extension protocol message
 *   GET  /gitgraph/:id/__status    cheap availability probe for the UI tab
 *
 * @module server/routes/git-graph
 */

import fs from "fs"
import path from "path"
import type { FastifyInstance } from "fastify"
import { resolveRepoRoot, listWorktrees } from "../../workspaces/git-worktrees.js"
import type { WorktreeDescriptor } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager.js"
import { acquireBridge, activeBridgeInfo, isGitGraphExtensionVendored, EXTENSION_ROOT } from "../../gitgraph/bridge.js"
import type { Logger } from "../../logger"

/** True when a request path belongs to the git-graph surface (session gate). */
export function isGitGraphPath(pathname: string): boolean {
  return pathname === "/gitgraph" || pathname.startsWith("/gitgraph/")
}

interface GitGraphRouteDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

/** Resolve the git directory backing a workspace tab: the workspace root, or
 * one of its linked worktrees when ?worktree=<slug> is given. */
async function resolveRepoForWorkspace(
  workspaceManager: WorkspaceManager,
  workspaceId: string,
  worktreeSlug: string | undefined,
  logger: Logger,
): Promise<{ repoPath: string; worktrees: WorktreeDescriptor[] | null }> {
  const workspace = workspaceManager.get(workspaceId)
  if (!workspace) throw Object.assign(new Error(`unknown workspace: ${workspaceId}`), { statusCode: 404 })
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspace.path, logger)
  if (!isGitRepo) throw Object.assign(new Error(`workspace is not a git repository: ${workspace.path}`), { statusCode: 422 })
  if (!worktreeSlug || worktreeSlug === "root") return { repoPath: repoRoot, worktrees: null }
  const worktrees = await listWorktrees({ repoRoot, workspaceFolder: workspace.path, logger })
  const match = worktrees.find((w) => w.slug === worktreeSlug)
  if (!match) throw Object.assign(new Error(`unknown worktree: ${worktreeSlug}`), { statusCode: 404 })
  return { repoPath: match.directory, worktrees }
}

export function registerGitGraphRoutes(app: FastifyInstance, deps: GitGraphRouteDeps): void {
  const { workspaceManager, logger } = deps

  const urlPrefix = (id: string) => `/gitgraph/${encodeURIComponent(id)}`

  // Availability probe — never boots the bridge, cheap enough to poll on tab open.
  app.get<{ Params: { id: string }; Querystring: { worktree?: string } }>(
    "/gitgraph/:id/__status",
    async (request, reply) => {
      if (!isGitGraphExtensionVendored()) {
        return reply.code(503).send({ available: false, reason: "vendored extension missing" })
      }
      try {
        const { repoPath } = await resolveRepoForWorkspace(workspaceManager, request.params.id, request.query.worktree, logger)
        return { available: true, repoPath, activeRepo: activeBridgeInfo()?.repoPath ?? null }
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode
        return reply.code(code ?? 500).send({ available: false, reason: (err as Error).message })
      }
    },
  )

  // HTML page. Boots (or reuses) the bridge for the resolved repo on demand.
  const htmlRoute = async (request: { params: { id: string }; query: { worktree?: string; theme?: string } }, reply: import("fastify").FastifyReply) => {
    try {
      const { repoPath } = await resolveRepoForWorkspace(workspaceManager, request.params.id, request.query.worktree, logger)
      const { bridge } = await acquireBridge({ repoPath, urlPrefix: urlPrefix(request.params.id), logger })
      if (!bridge.htmlReady) {
        return reply.code(503).type("text/plain").send("git-graph view is still starting — reload in a moment")
      }
      return reply.type("text/html; charset=utf-8").send(bridge.renderHtml(request.query.theme))
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      logger.warn({ err, workspace: request.params.id }, "[gitgraph] page load failed")
      return reply.code(code ?? 500).type("text/plain").send((err as Error).message)
    }
  }
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; theme?: string } }>("/gitgraph/:id/", htmlRoute as never)
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; theme?: string } }>("/gitgraph/:id", (request, reply) =>
    (htmlRoute as (r: unknown, r2: unknown) => Promise<unknown>)(request, reply),
  )

  // Static webview assets from the vendored extension (basename-only lookup).
  app.get<{ Params: { id: string; file: string } }>("/gitgraph/:id/media/:file", (request, reply) => {
    const file = path.basename(request.params.file)
    const filePath = path.join(EXTENSION_ROOT, "media", file)
    if (!filePath.startsWith(path.join(EXTENSION_ROOT, "media")) || !fs.existsSync(filePath)) {
      return reply.code(404).type("text/plain").send("not found")
    }
    const type = file.endsWith(".js")
      ? "application/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".woff") || file.endsWith(".woff2")
          ? "font/woff"
          : "application/octet-stream"
    return reply.type(type).send(fs.readFileSync(filePath))
  })

  // SSE: extension → webview. Hijacks the raw response (same pattern as /api/events).
  app.get<{ Params: { id: string }; Querystring: { worktree?: string } }>(
    "/gitgraph/:id/__events",
    async (request, reply) => {
      try {
        const { repoPath } = await resolveRepoForWorkspace(workspaceManager, request.params.id, request.query.worktree, logger)
        const { bridge } = await acquireBridge({ repoPath, urlPrefix: urlPrefix(request.params.id), logger })
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        })
        raw.write(": connected\n\n")
        bridge.addClient(raw)
        const keepAlive = setInterval(() => {
          try { raw.write(": keepalive\n\n") } catch { clearInterval(keepAlive) }
        }, 30_000)
        if (typeof keepAlive.unref === "function") keepAlive.unref()
        raw.on("close", () => clearInterval(keepAlive))
      } catch (err) {
        logger.warn({ err, workspace: request.params.id }, "[gitgraph] SSE failed")
        if (!reply.raw.headersSent) reply.code(500).send({ error: "gitgraph bridge unavailable" })
      }
    },
  )

  // webview → extension protocol message.
  app.post<{ Params: { id: string }; Querystring: { worktree?: string }; Body: unknown }>(
    "/gitgraph/:id/__request",
    async (request, reply) => {
      try {
        const { repoPath } = await resolveRepoForWorkspace(workspaceManager, request.params.id, request.query.worktree, logger)
        const { bridge } = await acquireBridge({ repoPath, urlPrefix: urlPrefix(request.params.id), logger })
        await bridge.respond(request.body)
        return reply.send({ ok: true })
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode
        logger.warn({ err, workspace: request.params.id }, "[gitgraph] request failed")
        return reply.code(code ?? 500).send({ ok: false, error: (err as Error).message })
      }
    },
  )
}
