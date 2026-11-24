import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import {
  isStarGuardJwtAllowed,
  resolveAuthProvider,
  resolveStarGuardPublicUrl,
  shouldRedirectLoginToStarGuard,
} from "../auth-provider"

describe("auth-provider", () => {
  const env = { ...process.env }

  beforeEach(() => {
    delete process.env.CODENOMAD_AUTH_PROVIDER
    delete process.env.CODENOMAD_PUBLIC_URL
    delete process.env.STARGUARD_PUBLIC_URL
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("defaults to starguard for tokenizin host", () => {
    process.env.CODENOMAD_PUBLIC_URL = "https://codenomad.tokenizin.com"
    expect(resolveAuthProvider()).toBe("starguard")
    expect(shouldRedirectLoginToStarGuard()).toBe(true)
  })

  it("uses cloudflare-access for prestix host", () => {
    process.env.CODENOMAD_PUBLIC_URL = "https://codenomad.prestix.vip"
    expect(resolveAuthProvider()).toBe("cloudflare-access")
    expect(shouldRedirectLoginToStarGuard()).toBe(false)
    expect(resolveStarGuardPublicUrl()).toBe("https://codenomad.prestix.vip")
  })

  it("honors explicit auth provider override", () => {
    process.env.CODENOMAD_AUTH_PROVIDER = "cloudflare-access"
    process.env.CODENOMAD_PUBLIC_URL = "https://codenomad.tokenizin.com"
    expect(resolveAuthProvider()).toBe("cloudflare-access")
  })

  it("password provider shows the local login page and refuses StarGuard JWTs", () => {
    process.env.CODENOMAD_AUTH_PROVIDER = "password"
    process.env.CODENOMAD_PUBLIC_URL = "https://stas.codenomad.tokenizin.com"
    expect(resolveAuthProvider()).toBe("password")
    expect(shouldRedirectLoginToStarGuard()).toBe(false)
    expect(isStarGuardJwtAllowed()).toBe(false)
  })

  it("accepts local as an alias for password", () => {
    process.env.CODENOMAD_AUTH_PROVIDER = "Local"
    expect(resolveAuthProvider()).toBe("password")
  })

  it("keeps StarGuard JWTs allowed for the default tokenizin instance", () => {
    process.env.CODENOMAD_PUBLIC_URL = "https://codenomad.tokenizin.com"
    expect(isStarGuardJwtAllowed()).toBe(true)
  })
})
