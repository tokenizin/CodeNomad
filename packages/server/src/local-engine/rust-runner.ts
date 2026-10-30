/**
 * Runs the build-your-own-claude-code Rust agent (playground/rust/your_program.sh).
 *
 * This replaces scripts/codenomad-rust-bridge.py from that repo: same behaviour
 * (agent as a "/agent" prefix, stdout/stderr streamed as NDJSON lines, optional
 * transcript recording via playground/persistence), without needing Python.
 * The Rust program itself still lives in the course checkout.
 */

import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"
import type { HistoryMessage } from "./store.js"

export type RustEvent =
  | { type: "meta"; engine: "rust-playground"; runner: string; agent: string | null }
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }

export function rustRunnerPath(playgroundRoot: string): string {
  return path.join(playgroundRoot, "playground", "rust", "your_program.sh")
}

export function findRustRunner(playgroundRoot: string | null): string | null {
  if (!playgroundRoot) return null
  const runner = rustRunnerPath(playgroundRoot)
  return fs.existsSync(runner) ? runner : null
}

/** Agent becomes a slash role, as the course bridge did: "/pma do the thing". */
export function rustPrompt(prompt: string, agent?: string): string {
  const role = (agent ?? "").replace(/^\/+/, "")
  if (!role || prompt.trimStart().startsWith("/")) return prompt
  return `/${role} ${prompt}`
}

const HISTORY_CHARS = 24_000

/**
 * The Rust agent has no memory between runs, so earlier turns are put in
 * front of the new message (newest kept when it gets long).
 */
export function withConversationContext(prompt: string, history: HistoryMessage[]): string {
  const turns: string[] = []
  let size = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message.isError || !message.text.trim()) continue
    const turn = `${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`
    if (size + turn.length > HISTORY_CHARS) break
    turns.unshift(turn)
    size += turn.length
  }
  if (turns.length === 0) return prompt
  return `Conversation so far:\n\n${turns.join("\n\n")}\n\n---\nNew message from the user:\n${prompt}`
}

export function runRustAgent(options: {
  runner: string
  prompt: string
  cwd: string
  env: NodeJS.ProcessEnv
  onEvent: (event: RustEvent) => void
  register: (child: ChildProcess) => void
}): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  return new Promise((resolve) => {
    try {
      fs.chmodSync(options.runner, fs.statSync(options.runner).mode | 0o111)
    } catch {
      /* not ours to fix; spawn will report it */
    }
    const stdout: string[] = []
    const stderr: string[] = []
    const child = spawn(options.runner, ["-p", options.prompt], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    options.register(child)

    const pipeLines = (stream: NodeJS.ReadableStream | null, type: "stdout" | "stderr", sink: string[]) => {
      let buffer = ""
      stream?.on("data", (buf: Buffer) => {
        buffer += buf.toString("utf8")
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          sink.push(line)
          options.onEvent({ type, line })
        }
      })
      stream?.on("end", () => {
        if (buffer) {
          sink.push(buffer)
          options.onEvent({ type, line: buffer })
          buffer = ""
        }
      })
    }
    pipeLines(child.stdout, "stdout", stdout)
    pipeLines(child.stderr, "stderr", stderr)

    let settled = false
    const finish = (code: number, error?: string) => {
      if (settled) return
      settled = true
      if (error) {
        stderr.push(error)
        options.onEvent({ type: "stderr", line: error })
      }
      resolve({ code, stdout, stderr })
    }
    child.on("error", (err) => finish(127, err.message))
    child.on("close", (code, signal) => finish(code ?? (signal ? 130 : 1)))
  })
}

/** Records the run in local Neon + MinIO via playground/persistence (best effort). */
export function recordRustTranscript(playgroundRoot: string, transcript: object[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const dir = path.join(playgroundRoot, "playground", "persistence")
  const recorder = path.join(dir, "src", "record-cli.ts")
  if (!fs.existsSync(recorder)) return Promise.resolve(`persistence recorder missing: ${recorder}`)
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", recorder, "--kind", "bridge"], { cwd: dir, env, stdio: ["pipe", "ignore", "pipe"] })
    let err = ""
    child.stderr?.on("data", (buf: Buffer) => (err += buf.toString("utf8")))
    child.on("error", (e) => resolve(`persistence skipped: ${e.message}`))
    child.on("close", (code) => resolve(code === 0 ? null : `persistence failed (${code}): ${err.trim().slice(-300)}`))
    child.stdin?.on("error", () => {})
    child.stdin?.end(transcript.map((line) => JSON.stringify(line)).join("\n") + "\n")
  })
}
