/**
 * Resolve a Python interpreter that can run local voice STT/TTS.
 *
 * LaunchAgent PATH prefers Homebrew python3 (PEP 668, often no user packages).
 * faster-whisper / piper are installed on macOS system Python (/usr/bin/python3).
 *
 * Override with PYTHON_PATH.
 */
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { platform } from "node:os"

function canImport(pythonBin: string, modules: string[]): boolean {
  try {
    execFileSync(
      pythonBin,
      ["-c", `import ${modules.join(",")}`],
      { stdio: "ignore", timeout: 8_000 },
    )
    return true
  } catch {
    return false
  }
}

let cached: string | null = null

export function resolveLocalVoicePython(requiredModules: string[] = ["faster_whisper"]): string {
  if (cached) return cached

  const fromEnv = process.env.PYTHON_PATH?.trim()
  if (fromEnv) {
    cached = fromEnv
    return cached
  }

  const candidates: string[] = []
  if (platform() === "darwin") {
    candidates.push("/usr/bin/python3")
  }
  candidates.push("python3", "python")

  for (const bin of candidates) {
    if (bin.includes("/") && !existsSync(bin)) continue
    if (canImport(bin, requiredModules)) {
      cached = bin
      return cached
    }
  }

  // Last resort — spawn will surface ImportError clearly
  cached = platform() === "darwin" ? "/usr/bin/python3" : "python3"
  return cached
}
