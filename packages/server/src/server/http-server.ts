import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import replyFrom from "@fastify/reply-from"
import fs from "fs"
import { connect as connectTcp, type Socket } from "net"
import path from "path"
import { connect as connectTls, type TLSSocket } from "tls"
import { fetch, type Headers } from "undici"
import type { Logger } from "../logger"
import { WorkspaceManager } from "../workspaces/manager"

import type { SettingsService } from "../settings/service"
import { FileSystemBrowser } from "../filesystem/browser"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "./routes/workspaces"
import { registerSettingsRoutes } from "./routes/settings"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerConfigFileRoutes } from "./routes/config-files"
import { registerMetaRoutes } from "./routes/meta"
import { registerTunnelRecoveryRoutes } from "./routes/tunnel-recovery"
import { registerEventRoutes } from "./routes/events"
import { registerStorageRoutes } from "./routes/storage"
import { registerPluginRoutes } from "./routes/plugin"
import { registerBackgroundProcessRoutes } from "./routes/background-processes"
import { registerWorktreeRoutes } from "./routes/worktrees"
import { registerSpeechRoutes } from "./routes/speech"
import { registerLocalLlmRoutes } from "./routes/local-llm"
import { registerTokidappRoutes, registerTokidappWebSocket, registerVoiceRealtimeWebSocket, registerRecordingRoutes } from "./routes/tokidapp"
import { registerRemoteServerRoutes } from "./routes/remote-servers"
import { registerRemoteProxyRoutes } from "./routes/remote-proxy"
import { registerSideCarRoutes } from "./routes/sidecars"
import { registerPreviewRoutes } from "./routes/previews"
import { ServerMeta } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import { BackgroundProcessManager } from "../background-processes/manager"
import type { AuthManager } from "../auth/manager"
import type { StarGuardJwtHandler } from "../auth/starguard-jwt"
import { registerAuthRoutes } from "./routes/auth"
import { sendUnauthorized, wantsHtml } from "../auth/http-auth"
import type { SpeechService } from "../speech/service"
import { getTokidappDb } from "../lib/db"
import { ClientConnectionManager } from "../clients/connection-manager"
import { PluginChannelManager } from "../plugins/channel"
import { VoiceModeManager } from "../plugins/voice-mode"
import type { SideCarManager } from "../sidecars/manager"
import type { PreviewManager } from "../previews/manager"
import type { RemoteProxySessionManager } from "./remote-proxy"
import {
  instanceProxyAllowsBody,
  resolveInstanceProxyBody,
  resolveInstanceProxyContentType,
} from "./instance-proxy-body"

// reply-from treats timeout 0 as unset and defaults to 10s — too short for LLM routes (summarize, command).
const INSTANCE_PROXY_HTTP_TIMEOUT_MS = 600_000

interface HttpServerDeps {
  bindHost: string
  bindPort: number
  /** When bindPort is 0, try this first. */
  defaultPort: number
  protocol: "http" | "https"
  httpsOptions?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer }
  workspaceManager: WorkspaceManager
  settings: SettingsService
  fileSystemBrowser: FileSystemBrowser
  eventBus: EventBus
  serverMeta: ServerMeta
  instanceStore: InstanceStore
  speechService: SpeechService
  sidecarManager: SideCarManager
  previewManager: PreviewManager
  authManager: AuthManager
  starGuardJwtHandler?: StarGuardJwtHandler
  clientConnectionManager: ClientConnectionManager
  pluginChannel: PluginChannelManager
  voiceModeManager: VoiceModeManager
  remoteProxySessionManager: RemoteProxySessionManager
  uiStaticDir: string
  uiDevServerUrl?: string
  logger: Logger
}

interface HttpServerStartResult {
  port: number
  url: string
  displayHost: string
}

export function createHttpServer(deps: HttpServerDeps) {
  // Fastify's type-level RawServer inference gets noisy when toggling HTTP vs HTTPS.
  // We keep the runtime behavior correct and cast the instance to a generic FastifyInstance.
  const app = Fastify(
    ({
      logger: false,
      trustProxy: true,
      ...(deps.protocol === "https" && deps.httpsOptions ? { https: deps.httpsOptions } : {}),
    } as unknown) as any,
  ) as unknown as FastifyInstance
  const proxyLogger = deps.logger.child({ component: "proxy" })
  const apiLogger = deps.logger.child({ component: "http" })
  const sseLogger = deps.logger.child({ component: "sse" })

  async function checkStarGuardJwt(request: FastifyRequest): Promise<boolean> {
    const handler = deps.starGuardJwtHandler
    if (!handler?.isEnabled()) return false

    let token: string | null = null
    const authHeader = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice("Bearer ".length).trim()
    }

    if (!token) {
      const query = request.query as { token?: string; starguard_token?: string } | undefined
      token = query?.starguard_token?.trim() || query?.token?.trim() || null
    }

    if (!token) return false
    const payload = await handler.verify(token)
    return payload !== null
  }

  const sseClients = new Set<() => void>()
  const registerSseClient = (cleanup: () => void) => {
    sseClients.add(cleanup)
    return () => sseClients.delete(cleanup)
  }
  const closeSseClients = () => {
    for (const cleanup of Array.from(sseClients)) {
      cleanup()
    }
    sseClients.clear()
  }

  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as FastifyRequest & { __logMeta?: { start: bigint } }).__logMeta = {
      start: process.hrtime.bigint(),
    }
    done()
  })

  app.addHook("onResponse", (request, reply, done) => {
    const meta = (request as FastifyRequest & { __logMeta?: { start: bigint } }).__logMeta
    const durationMs = meta ? Number((process.hrtime.bigint() - meta.start) / BigInt(1_000_000)) : undefined
    const base = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      durationMs,
    }
    apiLogger.debug(base, "HTTP request completed")
    if (apiLogger.isLevelEnabled("trace")) {
      apiLogger.trace({ ...base, params: request.params, query: request.query, body: request.body }, "HTTP request payload")
    }
    done()
  })

  const allowedDevOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"])
  const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("127.")

  const getStarGuardOrigins = (): Set<string> => {
    const origins = new Set<string>()
    const candidates = [
      process.env.STARGUARD_PUBLIC_URL,
      process.env.STARGUARD_BASE_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      "https://star-worlds.vercel.app",
    ]
    for (const candidate of candidates) {
      if (!candidate?.trim()) continue
      try {
        const raw = candidate.trim()
        const withScheme = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`
        origins.add(new URL(withScheme).origin)
      } catch {
        // ignore malformed URLs
      }
    }
    return origins
  }

  const getSelfOrigins = (): Set<string> => {
    const origins = new Set<string>()
    const candidates: Array<string | undefined> = [deps.serverMeta.localUrl, deps.serverMeta.remoteUrl]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        origins.add(new URL(candidate).origin)
      } catch {
        // ignore
      }
    }
    for (const addr of deps.serverMeta.addresses ?? []) {
      try {
        origins.add(new URL(addr.remoteUrl).origin)
      } catch {
        // ignore
      }
    }
    return origins
  }

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true)
        return
      }

      const selfOrigins = getSelfOrigins()
      if (selfOrigins.has(origin)) {
        cb(null, true)
        return
      }

       if (allowedDevOrigins.has(origin)) {
         cb(null, true)
         return
       }

       const starGuardOrigins = getStarGuardOrigins()
       if (starGuardOrigins.has(origin)) {
         cb(null, true)
         return
       }

       // When we bind to a non-loopback host (e.g., 0.0.0.0 or LAN IP), allow cross-origin UI access.
       if (deps.bindHost === "0.0.0.0" || !isLoopbackHost(deps.bindHost)) {
         cb(null, true)
         return
       }


      cb(null, false)
    },
    credentials: true,
  })

  // Bun + hoisted undici v7 breaks @fastify/reply-from v9's pool.request(); use Node http for localhost OpenCode proxy.
  app.register(replyFrom, {
    contentTypesToEncode: [],
    undici: false as any,
    http: {
      requestOptions: {
        timeout: INSTANCE_PROXY_HTTP_TIMEOUT_MS,
      },
    },
  })

  const backgroundProcessManager = new BackgroundProcessManager({
    workspaceManager: deps.workspaceManager,
    eventBus: deps.eventBus,
    logger: deps.logger.child({ component: "background-processes" }),
  })

  registerAuthRoutes(app, { authManager: deps.authManager, starGuardJwtHandler: deps.starGuardJwtHandler })

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") {
      return
    }

    const rawUrl = request.raw.url ?? request.url
    const pathname = (rawUrl.split("?")[0] ?? "").trim()

    const publicApiPaths = new Set(["/api/auth/login", "/api/auth/quick-login", "/api/auth/token", "/api/auth/status", "/api/auth/logout", "/api/tokidapp/status"])
    const publicPagePaths = new Set(["/login", "/auth/starguard"])
    if (deps.authManager.isTokenBootstrapEnabled()) {
      publicPagePaths.add("/auth/token")
    }

    const isLoopbackRemoteProxyDelete =
      request.method === "DELETE" &&
      pathname.startsWith("/api/remote-proxy/sessions/") &&
      deps.authManager.isLoopbackRequest(request)

    if (publicApiPaths.has(pathname) || publicPagePaths.has(pathname) || isLoopbackRemoteProxyDelete) {
      return
    }

    const session = deps.authManager.getSessionFromRequest(request)

    const requiresAuthForApi = pathname.startsWith("/api/") || pathname.startsWith("/workspaces/") || pathname.startsWith("/sidecars/") || pathname.startsWith("/previews/")
    if (requiresAuthForApi && !session) {
      // Allow StarGuard JWT (Authorization: Bearer <token>).
      if (await checkStarGuardJwt(request)) {
        return
      }

      // Allow OpenCode plugin -> CodeNomad calls with per-instance basic auth.
      const pluginMatch = pathname.match(/^\/workspaces\/([^/]+)\/plugin(?:\/|$)/)
      if (pluginMatch) {
        const workspaceId = pluginMatch[1]
        const expected = deps.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
        const provided = Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization

        if (expected && provided && provided === expected) {
          return
        }
      }

      sendUnauthorized(request, reply)
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }
  })

  app.get("/", async (request, reply) => {
    const session = deps.authManager.getSessionFromRequest(request)
    if (!session) {
      reply.redirect("/login")
      return
    }

    if (deps.uiDevServerUrl) {
      await proxyToDevServer(request, reply, deps.uiDevServerUrl)
      return
    }

    const uiDir = deps.uiStaticDir
    const indexPath = path.join(uiDir, "index.html")
    if (uiDir && fs.existsSync(indexPath)) {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
      return
    }

    reply.code(404).send({ message: "UI bundle missing" })
  })

  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager })
  registerSettingsRoutes(app, { settings: deps.settings, logger: apiLogger })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerConfigFileRoutes(app)
  registerMetaRoutes(app, { serverMeta: deps.serverMeta })
  registerTunnelRecoveryRoutes(app)
  registerEventRoutes(app, {
    eventBus: deps.eventBus,
    registerClient: registerSseClient,
    logger: sseLogger,
    connectionManager: deps.clientConnectionManager,
  })
  registerWorktreeRoutes(app, { workspaceManager: deps.workspaceManager })
  registerStorageRoutes(app, {
    instanceStore: deps.instanceStore,
    eventBus: deps.eventBus,
    workspaceManager: deps.workspaceManager,
  })
  registerRemoteServerRoutes(app, { logger: apiLogger })
  registerRemoteProxyRoutes(app, { logger: proxyLogger, sessionManager: deps.remoteProxySessionManager })
  registerSpeechRoutes(app, { speechService: deps.speechService })
  registerLocalLlmRoutes(app)
  registerSideCarRoutes(app, { sidecarManager: deps.sidecarManager })
  registerPreviewRoutes(app, { previewManager: deps.previewManager })
  registerSideCarProxyRoutes(app, {
    sidecarManager: deps.sidecarManager,
    authManager: deps.authManager,
    starGuardJwtHandler: deps.starGuardJwtHandler,
    logger: proxyLogger,
  })
  registerPreviewProxyRoutes(app, { previewManager: deps.previewManager, logger: proxyLogger })
  setupSideCarWebSocketProxy(app, {
    sidecarManager: deps.sidecarManager,
    authManager: deps.authManager,
    starGuardJwtHandler: deps.starGuardJwtHandler,
    logger: proxyLogger,
  })
  setupPreviewWebSocketProxy(app, {
    previewManager: deps.previewManager,
    authManager: deps.authManager,
    logger: proxyLogger,
  })
  registerTokidappWebSocket(app)
  registerVoiceRealtimeWebSocket(app, deps.starGuardJwtHandler)
  registerPluginRoutes(app, {
    workspaceManager: deps.workspaceManager,
    eventBus: deps.eventBus,
    logger: proxyLogger,
    channel: deps.pluginChannel,
    voiceModeManager: deps.voiceModeManager,
  })
  registerBackgroundProcessRoutes(app, { backgroundProcessManager })
  registerInstanceProxyRoutes(app, { workspaceManager: deps.workspaceManager, logger: proxyLogger })
  registerTokidappRoutes(app)
  registerRecordingRoutes(app)


  if (deps.uiDevServerUrl) {
    setupDevProxy(app, deps.uiDevServerUrl, deps.authManager, deps.previewManager, proxyLogger)
  } else {
    setupStaticUi(app, deps.uiStaticDir, deps.authManager, deps.previewManager, proxyLogger)
  }

  // Initialize DB connection pool on server start
  if (process.env.DATABASE_URL) {
    try {
      getTokidappDb()
      console.log('[http-server] DB connection pool initialized')
    } catch (err) {
      console.warn('[http-server] Failed to initialize DB pool:', err)
      console.warn('[http-server] TokiDAPP persistence will be degraded')
    }
  } else {
    console.log('[http-server] No DATABASE_URL — TokiDAPP persistence via proxy')
  }

  return {
    instance: app,
    start: async (): Promise<HttpServerStartResult> => {
      const attemptListen = async (requestedPort: number) => {
        const addressInfo = await app.listen({ port: requestedPort, host: deps.bindHost })
        return { addressInfo, requestedPort }
      }

      const autoPortRequested = deps.bindPort === 0
      const primaryPort = autoPortRequested ? deps.defaultPort : deps.bindPort

      const shouldRetryWithEphemeral = (error: unknown) => {
        if (!autoPortRequested) return false
        const err = error as NodeJS.ErrnoException | undefined
        return Boolean(err && err.code === "EADDRINUSE")
      }

      let listenResult

      try {
        listenResult = await attemptListen(primaryPort)
      } catch (error) {
        if (!shouldRetryWithEphemeral(error)) {
          throw error
        }
        deps.logger.warn({ err: error, port: primaryPort }, "Preferred port unavailable, retrying on ephemeral port")
        listenResult = await attemptListen(0)
      }

      let actualPort = listenResult.requestedPort

      if (typeof listenResult.addressInfo === "string") {
        try {
          const parsed = new URL(listenResult.addressInfo)
          actualPort = Number(parsed.port) || listenResult.requestedPort
        } catch {
          actualPort = listenResult.requestedPort
        }
      } else {
        const address = app.server.address()
        if (typeof address === "object" && address) {
          actualPort = address.port
        }
      }

      const displayHost = deps.bindHost === "127.0.0.1" ? "localhost" : deps.bindHost
      const serverUrl = `${deps.protocol}://${displayHost}:${actualPort}`

      deps.logger.info({ port: actualPort, host: deps.bindHost, protocol: deps.protocol }, "HTTP server listening")

      return { port: actualPort, url: serverUrl, displayHost }
    },
    stop: () => {
      closeSseClients()
      return app.close()
    },
  }
}

interface InstanceProxyDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

interface SideCarProxyDeps {
  sidecarManager: SideCarManager
  authManager: AuthManager
  starGuardJwtHandler?: StarGuardJwtHandler
  logger: Logger
}

interface SideCarWebSocketProxyDeps extends SideCarProxyDeps {
  authManager: AuthManager
}

interface PreviewProxyDeps {
  previewManager: PreviewManager
  logger: Logger
}

interface PreviewWebSocketProxyDeps extends PreviewProxyDeps {
  authManager: AuthManager
}

function registerSideCarProxyRoutes(app: FastifyInstance, deps: SideCarProxyDeps) {
  // ── Permission guard: only admin users and internal/loopback agents ──────
  const sidecarAuthGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    // 1. Loopback requests (internal agents / processes on the same machine) are always allowed.
    if (deps.authManager.isLoopbackRequest(request)) {
      return true
    }

    // 2. Check StarGuard JWT for admin role.
    const handler = deps.starGuardJwtHandler
    if (handler?.isEnabled()) {
      let token: string | null = null
      const authHeader = Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice("Bearer ".length).trim()
      }
      if (!token) {
        const query = request.query as { starguard_token?: string; token?: string } | undefined
        token = query?.starguard_token?.trim() || query?.token?.trim() || null
      }
      if (token) {
        const payload = await handler.verify(token)
        if (payload && (payload.role === "ADMIN" || payload.role === "SUPER_ADMIN")) {
          return true
        }
      }
    }

    // 3. Deny.
    reply.code(403).send({ error: "Forbidden: admin or internal-agent access required for sidecar services" })
    return false
  }

  const proxyBaseHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    // Trailing-slash redirect: /sidecars/:id → /sidecars/:id/
    // Without this, relative asset paths in proxied apps (Prisma Studio, pgweb, etc.)
    // resolve to /sidecars/assets/... instead of /sidecars/:id/assets/...
    const rawPath = request.raw.url ?? request.url ?? ""
    const pathOnly = rawPath.split("?")[0] ?? ""
    if (!pathOnly.endsWith("/")) {
      const search = rawPath.includes("?") ? rawPath.slice(rawPath.indexOf("?")) : ""
      reply.redirect(301, `${pathOnly}/${search}`)
      return
    }

    if (!(await sidecarAuthGuard(request, reply))) return
    await proxySideCarRequest({
      request,
      reply,
      sidecarManager: deps.sidecarManager,
      logger: deps.logger,
      pathSuffix: "",
    })
  }

  const proxyWildcardHandler = async (
    request: FastifyRequest<{ Params: { id: string; "*": string } }>,
    reply: FastifyReply,
  ) => {
    if (!(await sidecarAuthGuard(request, reply))) return
    await proxySideCarRequest({
      request,
      reply,
      sidecarManager: deps.sidecarManager,
      logger: deps.logger,
      pathSuffix: request.params["*"] ?? "",
    })
  }

  app.all("/sidecars/:id", proxyBaseHandler)
  app.all("/sidecars/:id/*", proxyWildcardHandler)
}

function registerPreviewProxyRoutes(app: FastifyInstance, deps: PreviewProxyDeps) {
  const proxyBaseHandler = async (
    request: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
  ) => {
    await proxyPreviewRequest({
      request,
      reply,
      previewManager: deps.previewManager,
      logger: deps.logger,
      pathSuffix: "",
    })
  }

  const proxyWildcardHandler = async (
    request: FastifyRequest<{ Params: { token: string; "*": string } }>,
    reply: FastifyReply,
  ) => {
    await proxyPreviewRequest({
      request,
      reply,
      previewManager: deps.previewManager,
      logger: deps.logger,
      pathSuffix: request.params["*"] ?? "",
    })
  }

  app.all("/previews/:token", proxyBaseHandler)
  app.all("/previews/:token/*", proxyWildcardHandler)
}

function setupSideCarWebSocketProxy(app: FastifyInstance, deps: SideCarWebSocketProxyDeps) {
  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
    const parsed = parseSideCarUpgradePath(rawUrl)
    if (!parsed) {
      return
    }

    void proxySideCarWebSocketUpgrade({
      request,
      socket: socket as Socket,
      head,
      sidecarId: parsed.sidecarId,
      incomingPath: parsed.pathname,
      search: parsed.search,
      sidecarManager: deps.sidecarManager,
      authManager: deps.authManager,
      starGuardJwtHandler: deps.starGuardJwtHandler,
      logger: deps.logger,
    })
  })
}

function setupPreviewWebSocketProxy(app: FastifyInstance, deps: PreviewWebSocketProxyDeps) {
  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
    const parsed = parsePreviewUpgradePath(rawUrl)
    if (!parsed) {
      return
    }

    void proxyPreviewWebSocketUpgrade({
      request,
      socket: socket as Socket,
      head,
      token: parsed.token,
      incomingPath: parsed.pathname,
      search: parsed.search,
      previewManager: deps.previewManager,
      authManager: deps.authManager,
      logger: deps.logger,
    })
  })
}

function registerInstanceProxyRoutes(app: FastifyInstance, deps: InstanceProxyDeps) {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    // Buffer the payload so reply-from gets bytes, not a stream that may arrive empty.
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body)
    })

    const proxyBaseHandler = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        pathSuffix: "",
        logger: deps.logger,
      })
    }

    const proxyWildcardHandler = async (
      request: FastifyRequest<{ Params: { id: string; "*": string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        pathSuffix: request.params["*"] ?? "",
        logger: deps.logger,
      })
    }

    instance.all("/workspaces/:id/instance", proxyBaseHandler)
    instance.all("/workspaces/:id/instance/*", proxyWildcardHandler)
  })
}

const INSTANCE_PROXY_HOST = "127.0.0.1"

async function proxyWorkspaceRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  workspaceManager: WorkspaceManager
  logger: Logger
  pathSuffix?: string
}) {
  const { request, reply, workspaceManager, logger } = args
  const workspaceId = (request.params as { id: string }).id
  const workspace = workspaceManager.get(workspaceId)

  const bodyToJson = (body: unknown): unknown => {
    if (body == null) return null

    const anyBody = body as any
    if (anyBody && typeof anyBody.pipe === "function") {
      // Don't consume streams (would break proxying).
      // Best-effort: if the stream already has buffered chunks, parse those.
      try {
        const buffered = anyBody?._readableState?.buffer
        if (Array.isArray(buffered) && buffered.length > 0) {
          const chunks: Buffer[] = []
          for (const entry of buffered) {
            if (!entry) continue
            if (Buffer.isBuffer(entry)) {
              chunks.push(entry)
              continue
            }
            const data = (entry as any).data
            if (Buffer.isBuffer(data)) {
              chunks.push(data)
            }
          }

          if (chunks.length > 0) {
            const text = Buffer.concat(chunks).toString("utf-8")
            try {
              return JSON.parse(text)
            } catch {
              return { __raw: text }
            }
          }
        }
      } catch {
        // fall through
      }

      return { __stream: true }
    }

    const maybeParse = (input: string): unknown => {
      try {
        return JSON.parse(input)
      } catch {
        return { __raw: input }
      }
    }

    if (Buffer.isBuffer(body)) {
      return maybeParse(body.toString("utf-8"))
    }

    if (typeof body === "string") {
      return maybeParse(body)
    }

    if (typeof body === "object") {
      return body
    }

    return body
  }

  if (!workspace) {
    reply.code(404).send({ error: "Workspace not found" })
    return
  }

  const port = workspaceManager.getInstancePort(workspaceId)
  if (!port) {
    reply.code(502).send({ error: "Workspace instance is not ready" })
    return
  }

  const normalizedSuffix = normalizeInstanceSuffix(args.pathSuffix)
  const queryIndex = (request.raw.url ?? "").indexOf("?")
  const search = queryIndex >= 0 ? (request.raw.url ?? "").slice(queryIndex) : ""
  const targetUrl = `http://${INSTANCE_PROXY_HOST}:${port}${normalizedSuffix}${search}`
  const instanceAuthHeader = workspaceManager.getInstanceAuthorizationHeader(workspaceId)

  logger.debug({ workspaceId, method: request.method, targetUrl }, "Proxying request to instance")
  if (logger.isLevelEnabled("trace")) {
    logger.trace({ workspaceId, targetUrl, body: bodyToJson(request.body) }, "Instance proxy payload")
  }

  const forwardBody = instanceProxyAllowsBody(request.method) ? resolveInstanceProxyBody(request) : undefined
  const forwardContentType =
    forwardBody !== undefined ? resolveInstanceProxyContentType(request) ?? "application/octet-stream" : undefined

  return reply.from(targetUrl, {
    ...(forwardBody !== undefined
      ? {
          body: forwardBody,
          contentType: forwardContentType,
        }
      : {}),
    rewriteRequestHeaders: (_originalRequest, headers) => {
      if (instanceAuthHeader) {
        headers.authorization = instanceAuthHeader
      }

      if (logger.isLevelEnabled("trace")) {
        const outgoing: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
          outgoing[key] = value
        }

        // Redact sensitive headers.
        for (const key of Object.keys(outgoing)) {
          const lower = key.toLowerCase()
          if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") {
            outgoing[key] = "<redacted>"
          }
        }

        logger.trace(
          {
            workspaceId,
            method: request.method,
            targetUrl,
            contentType: request.headers["content-type"],
            body: bodyToJson(request.body),
            headers: outgoing,
          },
          "Proxy -> OpenCode request",
        )
      }

      return headers
    },
    onError: (proxyReply, { error }) => {
      logger.error({ err: error, workspaceId, targetUrl }, "Failed to proxy workspace request")
      if (!proxyReply.sent) {
        proxyReply.code(502).send({ error: "Workspace instance proxy failed" })
      }
    },
  })
}

function normalizeInstanceSuffix(pathSuffix: string | undefined) {
  if (!pathSuffix || pathSuffix === "/") {
    return "/"
  }
  const trimmed = pathSuffix.replace(/^\/+/, "")
  return trimmed.length === 0 ? "/" : `/${trimmed}`
}

function setupStaticUi(
  app: FastifyInstance,
  uiDir: string,
  authManager: AuthManager,
  previewManager: PreviewManager,
  logger: Logger,
) {
  if (!uiDir) {
    app.log.warn("UI static directory not provided; API endpoints only")
    return
  }

  if (!fs.existsSync(uiDir)) {
    app.log.warn({ uiDir }, "UI static directory missing; API endpoints only")
    return
  }

  app.addHook("preHandler", (request, reply, done) => {
    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger)) {
      return
    }
    done()
  })

  app.register(fastifyStatic, {
    root: uiDir,
    prefix: "/",
    decorateReply: false,
  })

  const indexPath = path.join(uiDir, "index.html")

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger)) {
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    if (fs.existsSync(indexPath)) {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"))
    } else {
      reply.code(404).send({ message: "UI bundle missing" })
    }
  })
}

function setupDevProxy(
  app: FastifyInstance,
  upstreamBase: string,
  authManager: AuthManager,
  previewManager: PreviewManager,
  logger: Logger,
) {
  app.log.info({ upstreamBase }, "Proxying UI requests to development server")
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ""
    if (isApiRequest(url)) {
      reply.code(404).send({ message: "Not Found" })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (session && proxyPreviewFallbackFromReferer(request, reply, previewManager, logger)) {
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    void proxyToDevServer(request, reply, upstreamBase)
  })
}

function proxyPreviewFallbackFromReferer(
  request: FastifyRequest,
  reply: FastifyReply,
  previewManager: PreviewManager,
  logger: Logger,
): boolean {
  const rawUrl = request.raw.url ?? request.url ?? ""
  const pathname = rawUrl.split("?")[0] ?? ""
  if (!isPreviewFallbackPath(pathname)) {
    return false
  }

  const refererHeader = request.headers.referer ?? request.headers.referrer
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader
  if (!referer) {
    return false
  }

  const parsed = parsePreviewUpgradePath(referer)
  if (!parsed) {
    return false
  }

  void proxyPreviewAssetRequest({
    request,
    reply,
    previewManager,
    logger,
    token: parsed.token,
  })
  return true
}

function isPreviewFallbackPath(pathname: string): boolean {
  if (!pathname || pathname === "/") return false
  if (pathname.startsWith("/api/") || pathname === "/api") return false
  if (pathname.startsWith("/workspaces/")) return false
  if (pathname.startsWith("/sidecars/")) return false
  if (pathname.startsWith("/previews/")) return false
  if (pathname.startsWith("/auth/") || pathname === "/login") return false
  return true
}

async function proxyToDevServer(request: FastifyRequest, reply: FastifyReply, upstreamBase: string) {
  try {
    const targetUrl = new URL(request.raw.url ?? "/", upstreamBase)
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: buildProxyHeaders(request.headers),
    })

    response.headers.forEach((value, key) => {
      reply.header(key, value)
    })

    reply.code(response.status)

    if (!response.body || request.method === "HEAD") {
      reply.send()
      return
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    reply.send(buffer)
  } catch (error) {
    request.log.error({ err: error }, "Failed to proxy UI request to dev server")
    if (!reply.sent) {
      reply.code(502).send("UI dev server is unavailable")
    }
  }
}

function isApiRequest(rawUrl: string | null | undefined) {
  if (!rawUrl) return false
  const pathname = rawUrl.split("?")[0] ?? ""
  return pathname === "/api" || pathname.startsWith("/api/")
}

function buildProxyHeaders(headers: FastifyRequest["headers"]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!value || key.toLowerCase() === "host") continue
    result[key] = Array.isArray(value) ? value.join(",") : value
  }
  return result
}

function buildFetchProxyHeaders(headers: FastifyRequest["headers"], targetOrigin: string): Record<string, string> {
  const sanitized = sanitizeSideCarProxyRequestHeaders(
    headers as Record<string, string | string[] | undefined>,
    targetOrigin,
  )
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(sanitized)) {
    if (!value) continue
    if (key.toLowerCase() === "cookie") continue
    result[key] = Array.isArray(value) ? value.join(",") : value
  }
  return result
}

function headersToRecord(headers: Headers): Record<string, string | string[] | undefined> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = headers[key.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function shouldForwardRequestBody(method: string): boolean {
  const normalized = method.toUpperCase()
  return normalized !== "GET" && normalized !== "HEAD"
}

function isHtmlContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml")
}

function isCssContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/css")
}

function rewritePreviewBodyUrls(body: string, publicBase: string, kind: "html" | "css"): string {
  if (kind === "css") {
    return rewriteCssPreviewUrls(body, publicBase)
  }

  return rewriteCssPreviewUrls(
    body
      .replace(/\b(src|href|action|poster|data)=(["'])\/(?!\/)([^"']*)\2/gi, (_match, attr: string, quote: string, pathValue: string) => {
        return `${attr}=${quote}${publicBase}/${pathValue}${quote}`
      })
      .replace(/\bsrcset=(["'])([^"']*)\1/gi, (_match, quote: string, value: string) => {
        return `srcset=${quote}${rewriteSrcsetPreviewUrls(value, publicBase)}${quote}`
      }),
    publicBase,
  )
}

function rewriteCssPreviewUrls(body: string, publicBase: string): string {
  return body.replace(/url\((\s*)(["']?)\/(?!\/)([^"')]+)\2(\s*)\)/gi, (_match, before: string, quote: string, pathValue: string, after: string) => {
    return `url(${before}${quote}${publicBase}/${pathValue}${quote}${after})`
  })
}

function rewriteSrcsetPreviewUrls(value: string, publicBase: string): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmed = entry.trimStart()
      if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return entry
      const leading = entry.slice(0, entry.length - trimmed.length)
      return `${leading}${publicBase}${trimmed}`
    })
    .join(",")
}

async function proxySideCarRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  sidecarManager: SideCarManager
  logger: Logger
  pathSuffix?: string
}) {
  const sidecarId = (args.request.params as { id?: string }).id ?? ""
  const sidecar = await args.sidecarManager.get(sidecarId)
  if (!sidecar) {
    args.reply.code(404).send({ error: "SideCar not found" })
    return
  }

  const pathname = (args.request.raw.url ?? args.request.url ?? "").split("?")[0] ?? ""
  const queryIndex = (args.request.raw.url ?? args.request.url ?? "").indexOf("?")
  const search = queryIndex >= 0 ? (args.request.raw.url ?? args.request.url ?? "").slice(queryIndex) : ""
  const pathSuffix = args.pathSuffix ?? ""
  const requestPath = pathSuffix ? `${args.sidecarManager.buildProxyBasePath(sidecarId)}/${pathSuffix.replace(/^\/+/, "")}` : args.sidecarManager.buildProxyBasePath(sidecarId)
  const targetPath = args.sidecarManager.buildTargetPath(sidecarId, requestPath, search)
  const targetOrigin = args.sidecarManager.buildTargetOrigin(sidecar)
  const targetUrl = `${targetOrigin}${targetPath}`
  args.logger.debug({ sidecarId: sidecar.id, targetUrl, pathname, prefixMode: sidecar.prefixMode }, "Proxying request to SideCar")

  await proxyTargetRequest({
    reply: args.reply,
    logger: args.logger,
    targetUrl,
    targetOrigin,
    logContext: { sidecarId: sidecar.id },
    errorMessage: "SideCar proxy failed",
    rewriteHeaders: (headers) => rewriteSideCarResponseHeaders(headers, sidecarId, targetOrigin, sidecar.prefixMode),
  })
}

async function proxyPreviewRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  previewManager: PreviewManager
  logger: Logger
  pathSuffix?: string
}) {
  const token = (args.request.params as { token?: string }).token ?? ""
  const preview = args.previewManager.get(token)
  if (!preview) {
    args.reply.code(404).send({ error: "Preview not found" })
    return
  }

  const rawUrl = args.request.raw.url ?? args.request.url ?? ""
  const queryIndex = rawUrl.indexOf("?")
  const search = queryIndex >= 0 ? rawUrl.slice(queryIndex) : ""
  const pathSuffix = args.pathSuffix ?? ""
  const requestPath = pathSuffix ? `${args.previewManager.buildProxyBasePath(token)}/${pathSuffix.replace(/^\/+/, "")}` : args.previewManager.buildProxyBasePath(token)
  const targetUrl = args.previewManager.buildTargetUrl(token, requestPath, search)
  if (!targetUrl) {
    args.reply.code(404).send({ error: "Preview not found" })
    return
  }

  args.logger.debug({ previewToken: token, targetUrl: targetUrl.toString() }, "Proxying request to preview")
  await proxyPreviewTargetRequest({
    request: args.request,
    reply: args.reply,
    logger: args.logger,
    targetUrl: targetUrl.toString(),
    targetOrigin: targetUrl.origin,
    publicBase: args.previewManager.buildProxyBasePath(token),
    logContext: { previewToken: token },
    errorMessage: "Preview proxy failed",
    rewriteHeaders: (headers) => rewritePreviewResponseHeaders(headers, token, targetUrl.origin),
  })
}

async function proxyPreviewAssetRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  previewManager: PreviewManager
  logger: Logger
  token: string
}) {
  const rawUrl = args.request.raw.url ?? args.request.url ?? ""
  const queryIndex = rawUrl.indexOf("?")
  const search = queryIndex >= 0 ? rawUrl.slice(queryIndex) : ""
  const pathname = rawUrl.split("?")[0] ?? "/"
  const targetUrl = args.previewManager.buildTargetUrl(args.token, pathname, search)
  if (!targetUrl) {
    args.reply.code(404).send({ error: "Preview not found" })
    return
  }

  args.logger.debug({ previewToken: args.token, targetUrl: targetUrl.toString() }, "Proxying preview fallback asset")
  await proxyPreviewTargetRequest({
    request: args.request,
    reply: args.reply,
    logger: args.logger,
    targetUrl: targetUrl.toString(),
    targetOrigin: targetUrl.origin,
    publicBase: args.previewManager.buildProxyBasePath(args.token),
    logContext: { previewToken: args.token, previewFallback: true },
    errorMessage: "Preview proxy failed",
    rewriteHeaders: (headers) => rewritePreviewResponseHeaders(headers, args.token, targetUrl.origin),
  })
}

async function proxyPreviewTargetRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  logger: Logger
  targetUrl: string
  targetOrigin: string
  publicBase: string
  logContext: Record<string, unknown>
  errorMessage: string
  rewriteHeaders: (headers: Record<string, string | string[] | undefined>) => Record<string, string | string[] | undefined>
}) {
  try {
    const response = await fetch(args.targetUrl, {
      method: args.request.method,
      headers: buildFetchProxyHeaders(args.request.headers, args.targetOrigin),
      body: shouldForwardRequestBody(args.request.method) ? (args.request.raw as any) : undefined,
      duplex: shouldForwardRequestBody(args.request.method) ? "half" : undefined,
      redirect: "manual",
    } as any)

    const headers = args.rewriteHeaders(headersToRecord(response.headers))
    const contentType = getHeaderValue(headers, "content-type") ?? response.headers.get("content-type") ?? ""
    delete headers["content-length"]
    delete headers["content-encoding"]

    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) args.reply.header(key, value)
    }
    args.reply.code(response.status)

    if (!response.body || args.request.method === "HEAD") {
      args.reply.send()
      return
    }

    if (isHtmlContentType(contentType) || isCssContentType(contentType)) {
      const text = await response.text()
      args.reply.send(rewritePreviewBodyUrls(text, args.publicBase, isCssContentType(contentType) ? "css" : "html"))
      return
    }

    args.reply.send(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
    if (!args.reply.sent) {
      args.reply.code(502).send({ error: args.errorMessage })
    }
  }
}

async function proxyTargetRequest(args: {
  reply: FastifyReply
  logger: Logger
  targetUrl: string
  targetOrigin: string
  logContext: Record<string, unknown>
  errorMessage: string
  rewriteHeaders: (headers: Record<string, string | string[] | undefined>) => Record<string, string | string[] | undefined>
}) {
  await args.reply.from(args.targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) =>
      sanitizeSideCarProxyRequestHeaders(headers as Record<string, string | string[] | undefined>, args.targetOrigin),
    rewriteHeaders: args.rewriteHeaders,
    onError: (reply, { error }) => {
      args.logger.error({ ...args.logContext, err: error, targetUrl: args.targetUrl }, args.errorMessage)
      if (!reply.sent) {
        reply.code(502).send({ error: args.errorMessage })
      }
    },
  })
}

function parseSideCarUpgradePath(rawUrl: string): { sidecarId: string; pathname: string; search: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, "http://localhost")
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/sidecars\/([^/]+)(?:\/.*)?$/)
  if (!match) {
    return null
  }

  try {
    return {
      sidecarId: decodeURIComponent(match[1] ?? ""),
      pathname: parsed.pathname,
      search: parsed.search,
    }
  } catch {
    return null
  }
}

function parsePreviewUpgradePath(rawUrl: string): { token: string; pathname: string; search: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, "http://localhost")
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/previews\/([^/]+)(?:\/.*)?$/)
  if (!match) {
    return null
  }

  try {
    return {
      token: decodeURIComponent(match[1] ?? ""),
      pathname: parsed.pathname,
      search: parsed.search,
    }
  } catch {
    return null
  }
}

async function proxySideCarWebSocketUpgrade(args: {
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  sidecarId: string
  incomingPath: string
  search: string
  sidecarManager: SideCarManager
  authManager: AuthManager
  starGuardJwtHandler?: StarGuardJwtHandler
  logger: Logger
}) {
  const { request, socket, head, sidecarId, incomingPath, search, sidecarManager, authManager, starGuardJwtHandler, logger } = args

  if (!isWebSocketUpgradeRequest(request)) {
    rejectUpgrade(socket, 400, "Bad Request")
    return
  }

  // Permission guard: loopback (internal agents) OR admin StarGuard JWT.
  if (!authManager.isLoopbackRequest({ socket: { remoteAddress: request.socket.remoteAddress } } as FastifyRequest)) {
    let adminGranted = false
    if (starGuardJwtHandler?.isEnabled()) {
      const authHeader = Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null
      if (token) {
        const payload = await starGuardJwtHandler.verify(token)
        if (payload && (payload.role === "ADMIN" || payload.role === "SUPER_ADMIN")) {
          adminGranted = true
        }
      }
    }
    if (!adminGranted) {
      rejectUpgrade(socket, 403, "Forbidden: admin or internal-agent access required for sidecar services")
      return
    }
  }

  const sidecar = await sidecarManager.get(sidecarId)
  if (!sidecar) {
    rejectUpgrade(socket, 404, "Not Found")
    return
  }

  const targetOrigin = sidecarManager.buildTargetOrigin(sidecar)
  const targetPath = sidecarManager.buildTargetPath(sidecarId, incomingPath, search)
  const targetUrl = new URL(`${targetOrigin}${targetPath}`)
  logger.debug({ sidecarId, targetUrl: targetUrl.toString(), prefixMode: sidecar.prefixMode }, "Proxying websocket to SideCar")

  proxyTargetWebSocketUpgrade({
    request,
    socket,
    head,
    targetUrl,
    logger,
    logContext: { sidecarId },
    proxyLabel: "SideCar",
  })
}

async function proxyPreviewWebSocketUpgrade(args: {
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  token: string
  incomingPath: string
  search: string
  previewManager: PreviewManager
  authManager: AuthManager
  logger: Logger
}) {
  const { request, socket, head, token, incomingPath, search, previewManager, authManager, logger } = args

  if (!isWebSocketUpgradeRequest(request)) {
    rejectUpgrade(socket, 400, "Bad Request")
    return
  }

  const session = authManager.getSessionFromHeaders(request.headers)
  if (!session) {
    rejectUpgrade(socket, 401, "Unauthorized")
    return
  }

  const targetUrl = previewManager.buildTargetUrl(token, incomingPath, search)
  if (!targetUrl) {
    rejectUpgrade(socket, 404, "Not Found")
    return
  }

  logger.debug({ previewToken: token, targetUrl: targetUrl.toString() }, "Proxying websocket to preview")
  proxyTargetWebSocketUpgrade({
    request,
    socket,
    head,
    targetUrl,
    logger,
    logContext: { previewToken: token },
    proxyLabel: "preview",
    stripCookies: true,
  })
}

function proxyTargetWebSocketUpgrade(args: {
  request: import("http").IncomingMessage
  socket: Socket
  head: Buffer
  targetUrl: URL
  logger: Logger
  logContext: Record<string, unknown>
  proxyLabel: string
  stripCookies?: boolean
}) {
  const { request, socket, head, targetUrl, logger, logContext, proxyLabel, stripCookies } = args
  const { socket: upstream, readyEvent } = createSideCarUpstreamSocket(targetUrl)

  const closeBoth = () => {
    if (!socket.destroyed) {
      socket.destroy()
    }
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  }

  upstream.once("error", (error) => {
    logger.error({ ...logContext, err: error, targetUrl: targetUrl.toString() }, `Failed to proxy ${proxyLabel} websocket`)
    rejectUpgrade(socket, 502, "Bad Gateway")
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  socket.once("error", (error) => {
    logger.debug({ ...logContext, err: error }, `${proxyLabel} websocket client socket errored`)
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  upstream.once(readyEvent, () => {
    try {
      upstream.write(buildSideCarWebSocketRequest(request, targetUrl, { stripCookies }))
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    } catch (error) {
      logger.error({ ...logContext, err: error, targetUrl: targetUrl.toString() }, `Failed to forward ${proxyLabel} websocket upgrade`)
      closeBoth()
    }
  })

  upstream.once("close", () => {
    if (!socket.destroyed) {
      socket.end()
    }
  })

  socket.once("close", () => {
    if (!upstream.destroyed) {
      upstream.end()
    }
  })
}

function createSideCarUpstreamSocket(targetUrl: URL): { socket: Socket | TLSSocket; readyEvent: "connect" | "secureConnect" } {
  const port = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80))
  if (targetUrl.protocol === "https:") {
    return {
      socket: connectTls({
        host: targetUrl.hostname,
        port,
        servername: targetUrl.hostname,
      }),
      readyEvent: "secureConnect",
    }
  }
  return {
    socket: connectTcp(port, targetUrl.hostname),
    readyEvent: "connect",
  }
}

function buildSideCarWebSocketRequest(
  request: import("http").IncomingMessage,
  targetUrl: URL,
  options?: { stripCookies?: boolean },
): string {
  const pathWithQuery = `${targetUrl.pathname}${targetUrl.search}`
  const requestLine = `${request.method ?? "GET"} ${pathWithQuery} HTTP/${request.httpVersion}\r\n`
  const headerLines: string[] = []
  const rawHeaders = request.rawHeaders ?? []
  const blockedHeaders = getBlockedSideCarRequestHeaders()

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (!key || value === undefined) continue
    const lower = key.toLowerCase()
    if (blockedHeaders.has(lower)) continue
    if (options?.stripCookies && lower === "cookie") continue
    if (lower === "origin") {
      headerLines.push(`Origin: ${targetUrl.origin}\r\n`)
      continue
    }
    headerLines.push(`${key}: ${value}\r\n`)
  }

  const hostValue = targetUrl.port ? `${targetUrl.hostname}:${targetUrl.port}` : targetUrl.hostname
  headerLines.push(`Host: ${hostValue}\r\n`)
  headerLines.push("\r\n")

  return requestLine + headerLines.join("")
}

function isWebSocketUpgradeRequest(request: import("http").IncomingMessage): boolean {
  const upgrade = request.headers.upgrade
  if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
    return false
  }
  const connection = request.headers.connection
  const connectionValue = Array.isArray(connection) ? connection.join(",") : connection ?? ""
  return connectionValue.toLowerCase().split(",").map((part) => part.trim()).includes("upgrade")
}

function rejectUpgrade(socket: Socket, statusCode: number, statusText: string) {
  if (socket.destroyed) {
    return
  }
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function rewriteSideCarResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  sidecarId: string,
  targetOrigin: string,
  prefixMode: "strip" | "preserve",
) {
  if (prefixMode === "preserve") {
    return headers
  }

  const next = { ...headers }
  const locationHeader = next.location
  const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
  if (!location) {
    return next
  }

  const publicBase = `/sidecars/${encodeURIComponent(sidecarId)}`

  if (location.startsWith("/")) {
    next.location = `${publicBase}${location}`
    return next
  }

  try {
    const parsed = new URL(location)
    if (parsed.origin === targetOrigin) {
      next.location = `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Relative redirects should continue to resolve against the public sidecar path.
  }

  return next
}

function rewritePreviewResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  token: string,
  targetOrigin: string,
) {
  const next = { ...headers }
  delete next["x-frame-options"]
  delete next["content-security-policy"]
  delete next["content-security-policy-report-only"]
  delete next["set-cookie"]
  delete next["set-cookie2"]

  const locationHeader = next.location
  const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
  if (!location) {
    return next
  }

  const publicBase = `/previews/${encodeURIComponent(token)}`
  if (location.startsWith("/")) {
    next.location = `${publicBase}${location}`
    return next
  }

  try {
    const parsed = new URL(location)
    if (parsed.origin === targetOrigin) {
      next.location = `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Relative redirects should continue to resolve against the current preview path.
  }

  return next
}

function sanitizeSideCarProxyRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  targetOrigin: string,
): Record<string, string | string[] | undefined> {
  const blockedHeaders = getBlockedSideCarRequestHeaders()
  const next: Record<string, string | string[] | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (blockedHeaders.has(key.toLowerCase())) continue
    next[key] = value
  }

  next.origin = targetOrigin
  return next
}

function getBlockedSideCarRequestHeaders(): Set<string> {
  return new Set([
    "host",
    "authorization",
    "proxy-authorization",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ])
}
