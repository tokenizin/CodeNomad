import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify"
import { SignJWT } from "jose"
import { StarGuardJwtHandler } from "../starguard-jwt"
import { sendUnauthorized, wantsHtml } from "../http-auth"

const TEST_SECRET = "test-starguard-auth-secret-dont-use-in-prod-12345678"

function createTestApp(starGuardJwtHandler?: StarGuardJwtHandler): FastifyInstance {
  const authManager = createStubAuthManager()
  const workspaceManager = createStubWorkspaceManager()

  const app = Fastify({ logger: false })

  app.addHook("preHandler", async (request, reply) => {
    const rawUrl = request.raw.url ?? request.url
    const pathname = (rawUrl.split("?")[0] ?? "").trim()

    const publicPaths = new Set(["/api/auth/login", "/api/auth/token", "/api/auth/status", "/api/auth/logout"])
    if (publicPaths.has(pathname)) {
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (pathname.startsWith("/api/") && !session) {
      if (starGuardJwtHandler) {
        const authed = await checkStarGuardJwt(request, starGuardJwtHandler)
        if (authed) {
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

  app.get("/api/test", async () => {
    return { ok: true }
  })
  app.get("/api/auth/status", async () => {
    return { authenticated: false }
  })

  return app
}

async function checkStarGuardJwt(request: FastifyRequest, handler: StarGuardJwtHandler): Promise<boolean> {
  if (!handler.isEnabled()) return false
  const authHeader = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization
  if (!authHeader?.startsWith("Bearer ")) return false
  const token = authHeader.slice("Bearer ".length).trim()
  if (!token) return false
  const payload = await handler.verify(token)
  return payload !== null
}

function createStubAuthManager() {
  return {
    isTokenBootstrapEnabled: () => false,
    isLoopbackRequest: () => false,
    getSessionFromRequest: (_request: unknown) => null,
  }
}

function createStubWorkspaceManager() {
  return {
    getInstanceAuthorizationHeader: () => undefined,
  }
}

async function createStarGuardToken(payload: Record<string, unknown>, secret: string, expiresInSeconds = 3600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret))
}

async function createExpiredStarGuardToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) - 1
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret))
}

describe("StarGuard JWT shared auth bridge", () => {
  it("allows requests with a valid StarGuard JWT", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)
    const token = await createStarGuardToken(
      { userId: "user-1", walletAddress: "0x123", role: "USER" },
      TEST_SECRET,
    )

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    await app.close()
  })

  it("rejects requests without any auth header", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)

    const response = await app.inject({ method: "GET", url: "/api/test" })

    assert.equal(response.statusCode, 401)
    await app.close()
  })

  it("rejects requests with an invalid Bearer token", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: "Bearer this-is-not-a-valid-jwt" },
    })

    assert.equal(response.statusCode, 401)
    await app.close()
  })

  it("rejects requests with a token signed by a different secret", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)
    const token = await createStarGuardToken(
      { userId: "user-1", walletAddress: "0x123", role: "USER" },
      "different-secret-not-shared-with-starguard",
    )

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 401)
    await app.close()
  })

  it("rejects requests with an expired token", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)
    const token = await createExpiredStarGuardToken(
      { userId: "user-1", walletAddress: "0x123", role: "USER" },
      TEST_SECRET,
    )

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 401)
    await app.close()
  })

  it("passes through when StarGuardJwtHandler is not configured", async () => {
    const app = createTestApp(undefined)
    const token = await createStarGuardToken(
      { userId: "user-1", walletAddress: "0x123", role: "USER" },
      TEST_SECRET,
    )

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    })

    // Without handler configured, auth falls through to session check → 401
    assert.equal(response.statusCode, 401)
    await app.close()
  })

  it("leaves public API paths unauthenticated", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/status",
    })

    assert.equal(response.statusCode, 200)
    await app.close()
  })

  it("accepts a token with the real StarGuard payload shape", async () => {
    const handler = new StarGuardJwtHandler(TEST_SECRET, { warn: () => {} } as any)
    const app = createTestApp(handler)

    // StarGuard's createSessionToken produces this exact payload:
    const token = await createStarGuardToken(
      {
        userId: "clx123abc",
        walletAddress: "0xabcd1234deadbeef5678",
        role: "USER",
        email: "user@example.com",
      },
      TEST_SECRET,
    )

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200)
    await app.close()
  })
})
