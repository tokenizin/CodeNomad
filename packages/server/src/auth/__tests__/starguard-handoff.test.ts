import { describe, expect, it } from "bun:test"
import Fastify from "fastify"
import { SignJWT } from "jose"
import { registerAuthRoutes } from "../../server/routes/auth"
import { StarGuardJwtHandler } from "../starguard-jwt"
import { CODENOMAD_HANDOFF_AUDIENCE, exchangeStarGuardHandoff } from "../starguard-handoff"

const SECRET = "test-starguard-auth-secret-dont-use-in-prod-12345678"
const PORTAL = "https://www.tokenizin.com"
// Compact-JWT shaped; the exchange is mocked so only the shape matters here.
const HANDOFF = "aaa.bbb.ccc"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

async function sessionJwt() {
  return new SignJWT({ userId: "u1", walletAddress: "0xabc", role: "ADMIN", email: "a@b.co" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET))
}

describe("exchangeStarGuardHandoff", () => {
  it("posts the handoff + audience to the portal and returns the session token", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return json({ sessionToken: "sess.tok.en", audience: CODENOMAD_HANDOFF_AUDIENCE })
    }) as unknown as typeof fetch

    expect(await exchangeStarGuardHandoff(HANDOFF, { portalBaseUrl: `${PORTAL}/`, fetchImpl })).toBe("sess.tok.en")
    expect(seen?.url).toBe(`${PORTAL}/api/sso/exchange`)
    expect(seen?.init.method).toBe("POST")
    expect(JSON.parse(String(seen?.init.body))).toEqual({ handoffToken: HANDOFF, audience: "codeNomad" })
  })

  it("returns null without calling the portal for a malformed handoff", async () => {
    let calls = 0
    const fetchImpl = (async () => (calls++, json({ sessionToken: "x" }))) as unknown as typeof fetch
    for (const bad of ["", "   ", "not-a-jwt", "a.b", "a.b.c.d", `${"a".repeat(5000)}.b.c`]) {
      expect(await exchangeStarGuardHandoff(bad, { portalBaseUrl: PORTAL, fetchImpl })).toBeNull()
    }
    expect(calls).toBe(0)
  })

  it("returns null on portal rejection, bad body, wrong audience, network error and timeout", async () => {
    const cases: Array<typeof fetch> = [
      (async () => json({ error: "Handoff token already used" }, 401)) as unknown as typeof fetch,
      (async () => json({ error: "Too many requests" }, 429)) as unknown as typeof fetch,
      (async () => json({}, 200)) as unknown as typeof fetch,
      (async () => json({ sessionToken: 5 }, 200)) as unknown as typeof fetch,
      (async () => json({ sessionToken: "x.y.z", audience: "blog" }, 200)) as unknown as typeof fetch,
      (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
      (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
      ((_url: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch,
    ]
    for (const fetchImpl of cases) {
      expect(await exchangeStarGuardHandoff(HANDOFF, { portalBaseUrl: PORTAL, fetchImpl, timeoutMs: 20 })).toBeNull()
    }
  })
})

describe("GET /auth/starguard with ?handoff=", () => {
  function build(fetchImpl: typeof fetch) {
    const created: string[] = []
    const cookies: string[] = []
    const authManager = {
      getSessionFromRequest: () => null,
      getStatus: () => ({ username: "fallback" }),
      createSession: (username: string) => (created.push(username), { id: "sid-1" }),
      setSessionCookieWithOptions: (_reply: unknown, id: string) => void cookies.push(id),
    }
    const app = Fastify({ logger: false })
    registerAuthRoutes(app, {
      authManager: authManager as never,
      starGuardJwtHandler: new StarGuardJwtHandler(SECRET, { debug() {}, info() {}, warn() {}, error() {} } as never),
    })
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    return { app, created, cookies, restore: () => void (globalThis.fetch = original) }
  }

  it("exchanges the handoff, creates the session and redirects without bouncing to /login", async () => {
    const jwt = await sessionJwt()
    const { app, created, cookies, restore } = build((async () => json({ sessionToken: jwt, audience: "codeNomad" })) as unknown as typeof fetch)
    try {
      const res = await app.inject({ method: "GET", url: `/auth/starguard?handoff=${HANDOFF}&audience=codeNomad` })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe(`/#starguard_token=${encodeURIComponent(jwt)}`)
      expect(created).toEqual(["a@b.co"])
      expect(cookies).toEqual(["sid-1"])
    } finally {
      restore()
    }
  })

  it("answers 401 (not a redirect to /login) when the exchange fails", async () => {
    const { app, created, restore } = build((async () => json({ error: "Handoff token already used" }, 401)) as unknown as typeof fetch)
    try {
      const res = await app.inject({ method: "GET", url: `/auth/starguard?handoff=${HANDOFF}&audience=codeNomad` })
      expect(res.statusCode).toBe(401)
      expect(res.headers.location).toBeUndefined()
      expect(created).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects a handoff for another audience with 400 and never calls the portal", async () => {
    let calls = 0
    const { app, restore } = build((async () => (calls++, json({}))) as unknown as typeof fetch)
    try {
      for (const url of [`/auth/starguard?handoff=${HANDOFF}&audience=blog`, `/auth/starguard?handoff=${HANDOFF}`]) {
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(400)
      }
      expect(calls).toBe(0)
    } finally {
      restore()
    }
  })

  it("still accepts the legacy ?starguard_token= and falls back to /login with nothing", async () => {
    const jwt = await sessionJwt()
    const { app, created, restore } = build((async () => json({}, 500)) as unknown as typeof fetch)
    try {
      const legacy = await app.inject({ method: "GET", url: `/auth/starguard?starguard_token=${jwt}` })
      expect(legacy.statusCode).toBe(302)
      expect(legacy.headers.location).toBe(`/#starguard_token=${encodeURIComponent(jwt)}`)
      expect(created).toEqual(["a@b.co"])

      const none = await app.inject({ method: "GET", url: "/auth/starguard" })
      expect(none.statusCode).toBe(302)
      expect(none.headers.location).toBe("/login")
    } finally {
      restore()
    }
  })
})
