import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import Fastify from "fastify"
import { SignJWT } from "jose"
import { registerAuthRoutes } from "../../server/routes/auth"
import { StarGuardJwtHandler } from "../starguard-jwt"
import { isMultiUserChatPath, isOwnerIdentity, isOwnerLockEnabled } from "../owner-allowlist"

const SECRET = "test-owner-allowlist-secret-dont-use-in-prod-12345678"

async function jwtFor(claims: Record<string, unknown>) {
  return new SignJWT({ userId: "u1", walletAddress: "0xabc", role: "USER", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET))
}

describe("owner allowlist", () => {
  const original = process.env.CODENOMAD_OWNER_EMAILS

  beforeEach(() => {
    delete process.env.CODENOMAD_OWNER_EMAILS
  })

  afterEach(() => {
    if (original === undefined) delete process.env.CODENOMAD_OWNER_EMAILS
    else process.env.CODENOMAD_OWNER_EMAILS = original
  })

  it("accepts any identity when unset (legacy behaviour)", () => {
    expect(isOwnerLockEnabled()).toBe(false)
    expect(isOwnerIdentity({ email: "someone@else.com" })).toBe(true)
    expect(isOwnerIdentity(null)).toBe(false)
  })

  it("matches listed emails case-insensitively and refuses everyone else", () => {
    process.env.CODENOMAD_OWNER_EMAILS = " Owner@Example.com , second@example.com"
    expect(isOwnerLockEnabled()).toBe(true)
    expect(isOwnerIdentity({ email: "owner@example.com" })).toBe(true)
    expect(isOwnerIdentity({ email: "SECOND@example.com " })).toBe(true)
    expect(isOwnerIdentity({ email: "stas@example.com" })).toBe(false)
    expect(isOwnerIdentity({ email: undefined })).toBe(false)
  })

  it("treats only StarWorld chat routes as multi-user", () => {
    expect(isMultiUserChatPath("/api/tokidapp/messages")).toBe(true)
    expect(isMultiUserChatPath("/api/tokidapp")).toBe(true)
    expect(isMultiUserChatPath("/api/tokidappx")).toBe(false)
    expect(isMultiUserChatPath("/api/workspaces")).toBe(false)
    expect(isMultiUserChatPath("/workspaces/abc/files")).toBe(false)
  })

  describe("GET /auth/starguard", () => {
    function build() {
      const created: string[] = []
      const authManager = {
        getSessionFromRequest: () => null,
        getStatus: () => ({ username: "fallback" }),
        createSession: (username: string) => (created.push(username), { id: "sid-1" }),
        setSessionCookieWithOptions: () => {},
      }
      const app = Fastify({ logger: false })
      registerAuthRoutes(app, {
        authManager: authManager as never,
        starGuardJwtHandler: new StarGuardJwtHandler(SECRET, { debug() {}, info() {}, warn() {}, error() {} } as never),
      })
      return { app, created }
    }

    it("creates a session for the owner", async () => {
      process.env.CODENOMAD_OWNER_EMAILS = "owner@example.com"
      const { app, created } = build()
      const res = await app.inject({ method: "GET", url: `/auth/starguard?token=${await jwtFor({ email: "owner@example.com" })}` })
      expect(res.statusCode).toBe(302)
      expect(created).toEqual(["owner@example.com"])
    })

    it("answers 403 without a session for another valid account", async () => {
      process.env.CODENOMAD_OWNER_EMAILS = "owner@example.com"
      const { app, created } = build()
      const res = await app.inject({ method: "GET", url: `/auth/starguard?token=${await jwtFor({ email: "stas@example.com" })}` })
      expect(res.statusCode).toBe(403)
      expect(res.headers.location).toBeUndefined()
      expect(created).toEqual([])
    })

    it("refuses wallet-only tokens when the lock is on", async () => {
      process.env.CODENOMAD_OWNER_EMAILS = "owner@example.com"
      const { app, created } = build()
      const res = await app.inject({ method: "GET", url: `/auth/starguard?token=${await jwtFor({})}` })
      expect(res.statusCode).toBe(403)
      expect(created).toEqual([])
    })
  })
})
