import { FastifyInstance } from "fastify"
import { ServerMeta } from "../../api-types"
import { isLoopbackAddress } from "../../auth/http-auth"

// Headers a reverse proxy or the Cloudflare tunnel adds. cloudflared connects from 127.0.0.1, so the socket address
// alone cannot tell the host's own curl apart from a visitor on the internet.
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "cf-connecting-ip", "cf-ray", "cf-visitor"]
 

interface RouteDeps {
  serverMeta: ServerMeta
}

export function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/meta", async () => buildMetaResponse(deps.serverMeta))

  // Which build is this process running? Used by the deploy scripts on the host (no login there). Unauthenticated,
  // so it answers only a direct loopback request; anything that came through the tunnel gets the same 404 as an
  // unknown path.
  app.get("/api/build-stamp", async (request, reply) => {
    const viaProxy = PROXY_HEADERS.some((name) => request.headers[name] !== undefined)
    if (viaProxy || !isLoopbackAddress(request.socket.remoteAddress)) {
      reply.code(404)
      return { error: "Not found" }
    }
    return { build: deps.serverMeta.build ?? null, serverVersion: deps.serverMeta.serverVersion ?? null }
  })
}

function buildMetaResponse(meta: ServerMeta): ServerMeta {
  const localPort = resolveLocalPort(meta)
  const remote = resolveRemote(meta)

  return {
    ...meta,
    localPort,
    remotePort: remote?.port,
    listeningMode: meta.host === "0.0.0.0" || !isLoopbackHost(meta.host) ? "all" : "local",
  }
}

function resolveLocalPort(meta: ServerMeta): number {
  if (Number.isInteger(meta.localPort) && meta.localPort > 0) {
    return meta.localPort
  }
  try {
    const parsed = new URL(meta.localUrl)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

function resolveRemote(meta: ServerMeta): { protocol: "http" | "https"; port: number } | null {
  if (!meta.remoteUrl) {
    return null
  }
  try {
    const parsed = new URL(meta.remoteUrl)
    const protocol = parsed.protocol === "https:" ? "https" : "http"
    const port = Number(parsed.port)
    return { protocol, port: Number.isInteger(port) && port > 0 ? port : 0 }
  } catch {
    return null
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.startsWith("127.")
}

// NetworkAddress shape is resolved in ../network-addresses
