import { spawn } from "child_process"
import os from "os"

export interface WorkspaceExecResult {
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

const MAX_OUTPUT_CHARS = 400_000
const DEFAULT_TIMEOUT_MS = 60_000

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated]`
}

export function execInDirectory(
  cwd: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WorkspaceExecResult> {
  const started = Date.now()
  const shell = process.env.SHELL?.trim() || (os.platform() === "win32" ? "cmd.exe" : "/bin/bash")
  const args = os.platform() === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command]

  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, 2_000)
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        command,
        cwd,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode: timedOut ? 124 : code,
        timedOut,
        durationMs: Date.now() - started,
      })
    })
  })
}
