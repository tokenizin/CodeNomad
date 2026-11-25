import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

/** Written by scripts/write-build-stamp.mjs as part of `npm run build`. */
export interface BuildStamp {
  id: string
  short: string
  branch: string
  dirty: boolean
  builtAt: string
}

/** packages/server/build-stamp.json, found relative to src/ (bun/tsx) or a compiled copy of it. */
export function defaultBuildStampPath(fromUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), "../build-stamp.json")
}

/** Read once at startup, so the stamp always describes the build this process was started from. */
export function readBuildStamp(file: string = defaultBuildStampPath()): BuildStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BuildStamp>
    if (typeof parsed.id !== "string" || typeof parsed.builtAt !== "string") return null
    return {
      id: parsed.id,
      short: typeof parsed.short === "string" ? parsed.short : parsed.id.slice(0, 8),
      branch: typeof parsed.branch === "string" ? parsed.branch : "",
      dirty: parsed.dirty === true,
      builtAt: parsed.builtAt,
    }
  } catch {
    return null
  }
}
