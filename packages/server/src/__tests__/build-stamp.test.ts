import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { readBuildStamp } from "../build-stamp"
import { registerMetaRoutes } from "../server/routes/meta"
import type { ServerMeta } from "../api-types"

const WRITER = path.resolve(import.meta.dir, "../../scripts/write-build-stamp.mjs")

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-stamp-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("readBuildStamp", () => {
  it("reads a valid stamp and fills optional fields", () => {
    const file = path.join(dir, "stamp.json")
    fs.writeFileSync(file, JSON.stringify({ id: "abcdef1234567890", builtAt: "2026-11-25T00:00:00.000Z" }))
    expect(readBuildStamp(file)).toEqual({ id: "abcdef1234567890", short: "abcdef12", branch: "", dirty: false, builtAt: "2026-11-25T00:00:00.000Z" })
  })

  it("returns null for a missing file, bad JSON, or missing id/builtAt", () => {
    expect(readBuildStamp(path.join(dir, "nope.json"))).toBeNull()
    const bad = path.join(dir, "bad.json")
    fs.writeFileSync(bad, "{not json")
    expect(readBuildStamp(bad)).toBeNull()
    fs.writeFileSync(bad, JSON.stringify({ id: "x" }))
    expect(readBuildStamp(bad)).toBeNull()
  })
})

describe("GET /api/build-stamp", () => {
  const meta = {
    serverVersion: "9.9.9",
    build: { id: "abc", short: "abc", branch: "starwarp", dirty: false, builtAt: "2026-11-25T00:00:00.000Z" },
  } as unknown as ServerMeta

  function app(serverMeta: ServerMeta = meta) {
    const instance = Fastify({ logger: false })
    registerMetaRoutes(instance, { serverMeta })
    return instance
  }

  it("answers a direct loopback request with the build", async () => {
    const res = await app().inject({ method: "GET", url: "/api/build-stamp", remoteAddress: "127.0.0.1" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ build: meta.build, serverVersion: "9.9.9" })
  })

  it("reports build: null when the server has no stamp", async () => {
    const res = await app({ serverVersion: "9.9.9" } as ServerMeta).inject({ method: "GET", url: "/api/build-stamp", remoteAddress: "::1" })
    expect(res.json()).toEqual({ build: null, serverVersion: "9.9.9" })
  })

  it("answers 404 to a non-loopback address", async () => {
    const res = await app().inject({ method: "GET", url: "/api/build-stamp", remoteAddress: "203.0.113.9" })
    expect(res.statusCode).toBe(404)
  })

  it("answers 404 to loopback requests that came through a proxy or the tunnel", async () => {
    for (const header of ["x-forwarded-for", "x-forwarded-host", "forwarded", "cf-connecting-ip", "cf-ray", "cf-visitor"]) {
      const res = await app().inject({ method: "GET", url: "/api/build-stamp", remoteAddress: "127.0.0.1", headers: { [header]: "1.2.3.4" } })
      expect(res.statusCode).toBe(404)
    }
  })
})

describe("write-build-stamp.mjs", () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: gitEnv, encoding: "utf8" }).trim()
  const run = (root: string, out: string) => execFileSync("node", [WRITER, "--root", root, "--out", out], { encoding: "utf8" })

  it("records HEAD, branch and a clean tree, and ignores untracked files", () => {
    const repo = path.join(dir, "repo")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "starwarp")
    fs.writeFileSync(path.join(repo, "a.txt"), "a")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "init")
    fs.writeFileSync(path.join(repo, "untracked.txt"), "build output")
    const out = path.join(dir, "stamp.json")
    run(repo, out)
    const stamp = JSON.parse(fs.readFileSync(out, "utf8"))
    expect(stamp.id).toBe(git(repo, "rev-parse", "HEAD"))
    expect(stamp.short).toBe(stamp.id.slice(0, 8))
    expect(stamp.branch).toBe("starwarp")
    expect(stamp.dirty).toBe(false)
  })

  it("flags tracked modifications as dirty", () => {
    const repo = path.join(dir, "repo")
    fs.mkdirSync(repo)
    git(repo, "init", "-q")
    fs.writeFileSync(path.join(repo, "a.txt"), "a")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "init")
    fs.writeFileSync(path.join(repo, "a.txt"), "changed")
    const out = path.join(dir, "stamp.json")
    run(repo, out)
    expect(JSON.parse(fs.readFileSync(out, "utf8")).dirty).toBe(true)
  })

  it("keeps an existing stamp when there is no git checkout (a per-user copy)", () => {
    const out = path.join(dir, "stamp.json")
    const existing = { id: "1111111111111111", short: "11111111", branch: "starwarp", dirty: false, builtAt: "2026-01-01T00:00:00.000Z" }
    fs.writeFileSync(out, JSON.stringify(existing))
    run(path.join(dir, "not-a-repo"), out)
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(existing)
  })

  it("writes an 'unknown' stamp when there is neither git nor an existing stamp", () => {
    const out = path.join(dir, "stamp.json")
    run(path.join(dir, "not-a-repo"), out)
    expect(JSON.parse(fs.readFileSync(out, "utf8")).id).toBe("unknown")
  })
})
