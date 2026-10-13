/**
 * P4 — CodeNomad ↔ playground/rust bridge.
 *
 * POST /api/playground/rust/run
 *   body: { prompt, cwd?, agent?, jsonl? }
 *   response: NDJSON stream (meta | stderr | stdout | final | exit) when jsonl=true
 *             or plain text (final answer) when jsonl=false
 *
 * Resolves the course-repo bridge via CLAUDE_CODE_PLAYGROUND or sibling paths.
 */

import { spawn } from "child_process"
import fs from "fs"
import path from "path"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

const BodySchema = z.object({
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).max(64).optional(),
  jsonl: z.boolean().optional().default(true),
  /** Persist NDJSON transcript to Neon + MinIO (playground/persistence). */
  persist: z.boolean().optional().default(false),
})

function resolveBridgeScript(): string | null {
  const candidates: string[] = []
  const envRoot = process.env.CLAUDE_CODE_PLAYGROUND?.trim()
  if (envRoot) {
    candidates.push(path.join(envRoot, "scripts", "codenomad-rust-bridge.py"))
    candidates.push(path.join(envRoot, "scripts", "codenomad-rust-bridge.sh"))
  }
  // Common local layouts: CodeNomad inside starworld, course repo sibling of starworld
  const cwd = process.cwd()
  candidates.push(
    path.resolve(cwd, "../../0-claudecode/build-your-own-claude-code/scripts/codenomad-rust-bridge.py"),
    path.resolve(cwd, "../../../0-claudecode/build-your-own-claude-code/scripts/codenomad-rust-bridge.py"),
    path.resolve(cwd, "../../../../0-claudecode/build-your-own-claude-code/scripts/codenomad-rust-bridge.py"),
    "/Users/alexshapiro/0-claudecode/build-your-own-claude-code/scripts/codenomad-rust-bridge.py",
  )
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function registerPlaygroundRustRoutes(app: FastifyInstance) {
  app.post("/api/playground/rust/run", async (request, reply) => {
    const parsed = BodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid body", details: parsed.error.flatten() }
    }

    const bridge = resolveBridgeScript()
    if (!bridge) {
      reply.code(503)
      return {
        error: "playground rust bridge not found",
        hint: "Set CLAUDE_CODE_PLAYGROUND to the build-your-own-claude-code repo root",
      }
    }

    const { prompt, agent, jsonl, persist } = parsed.data
    const cwd = parsed.data.cwd?.trim() || process.env.CLI_WORKSPACE_ROOT || process.cwd()
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      reply.code(400)
      return { error: `cwd is not a directory: ${cwd}` }
    }

    const args = [bridge, "--prompt", prompt, "--cwd", cwd]
    if (agent) args.push("--agent", agent)
    if (jsonl) args.push("--jsonl")
    if (persist || process.env.PLAYGROUND_PERSIST === "1") args.push("--persist")

    reply.raw.setHeader(
      "Content-Type",
      jsonl ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8",
    )
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Playground-Rust-Bridge", bridge)
    reply.raw.flushHeaders?.()
    reply.hijack()

    const starworld = process.env.STARWORLD || process.env.CLI_WORKSPACE_ROOT || "/Users/alexshapiro/starworld"
    const child = spawn("python3", args, {
      cwd,
      env: {
        ...process.env,
        STARWORLD: starworld,
        CLAUDE_CODE_PLAYGROUND:
          process.env.CLAUDE_CODE_PLAYGROUND ||
          "/Users/alexshapiro/0-claudecode/build-your-own-claude-code",
        OPENCODE_CONFIG:
          process.env.OPENCODE_CONFIG ||
          path.join(starworld, "CodeNomad/.opencode/opencode.jsonc"),
        NOMAD_AGENTS: process.env.NOMAD_AGENTS || "opencode",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const write = (chunk: Buffer | string) => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(chunk)
      }
    }

    child.stdout?.on("data", (buf: Buffer) => write(buf))
    child.stderr?.on("data", (buf: Buffer) => {
      // When not jsonl, bridge already routes diagnostics to its stderr; surface them.
      if (!jsonl) {
        write(buf)
      } else {
        // Bridge puts diagnostics inside NDJSON; stray python warnings go here.
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue
          write(JSON.stringify({ type: "bridge_stderr", line }) + "\n")
        }
      }
    })

    child.on("error", (err) => {
      write(JSON.stringify({ type: "exit", code: 1, error: err.message }) + "\n")
      reply.raw.end()
    })

    child.on("close", () => {
      if (!reply.raw.writableEnded) {
        reply.raw.end()
      }
    })

    request.raw.on("close", () => {
      if (!child.killed) {
        child.kill("SIGTERM")
      }
    })
  })

  app.get("/api/playground/rust/status", async () => {
    const bridge = resolveBridgeScript()
    const starworld = process.env.STARWORLD || "/Users/alexshapiro/starworld"
    const openCodeConfig =
      process.env.OPENCODE_CONFIG ||
      path.join(starworld, "CodeNomad/.opencode/opencode.jsonc")
    return {
      ok: Boolean(bridge),
      bridge,
      claudeCodePlayground: process.env.CLAUDE_CODE_PLAYGROUND || null,
      starworld: process.env.STARWORLD || null,
      openCodeConfig: fs.existsSync(openCodeConfig) ? openCodeConfig : null,
      nomadAgents: process.env.NOMAD_AGENTS || "opencode",
      persist: process.env.PLAYGROUND_PERSIST === "1",
      hint: "POST /api/playground/rust/run { prompt, cwd?, agent?, jsonl?, persist? } — agent names match CodeNomad opencode.jsonc (pma, product_manager, ceo, …)",
    }
  })
}
