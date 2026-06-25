import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { createLogger } from "./logger"

const log = createLogger({ component: "opencode-plugin" })
const pluginPackageName = "@codenomad/codenomad-opencode-plugin"
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
const devPluginEntry = path.resolve(__dirname, "../../opencode-plugin/plugin/codenomad.ts")
const prodPluginDirs = [
  resourcesPath ? path.resolve(resourcesPath, "opencode-plugin") : undefined,
  resourcesPath ? path.resolve(resourcesPath, "server/dist/opencode-plugin") : undefined,
  path.resolve(__dirname, "opencode-plugin"),
].filter((dir): dir is string => Boolean(dir))

const isDevBuild = Boolean(
  process.env.CODENOMAD_DEV ??
    process.env.CLI_UI_DEV_SERVER ??
    process.env.VITE_DEV_SERVER_URL ??
    process.env.ELECTRON_RENDERER_URL,
)
const isSourceRun = path.basename(__dirname) === "src" && existsSync(devPluginEntry)

export function getCodeNomadPluginUrl(): string {
  if (isDevBuild || isSourceRun) {
    if (!existsSync(devPluginEntry)) {
      throw new Error(`CodeNomad OpenCode plugin entry missing at ${devPluginEntry}`)
    }

    log.debug({ pluginEntry: devPluginEntry }, "Using OpenCode plugin source directly (dev mode)")
    return pathToFileURL(devPluginEntry).href
  }

  for (const dir of prodPluginDirs) {
    const tarball = findPluginTarball(dir)
    if (tarball) {
      return toNpmFileSpecifier(tarball)
    }
  }

  throw new Error(`CodeNomad OpenCode plugin package missing in ${prodPluginDirs.join(", ")}`)
}

export function resolveTunnelProfilePath(workspaceRoot?: string): string | undefined {
  const explicit = process.env.OPENCODE_TUNNEL_PROFILE_PATH?.trim()
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit)
  }
  if (process.env.CODENOMAD_OPENCODE_TUNNEL_PROFILE !== "true") {
    return undefined
  }
  const root = workspaceRoot?.trim() || process.env.CLI_WORKSPACE_ROOT?.trim() || process.cwd()
  return path.resolve(root, ".opencode/profiles/tunnel.json")
}

export function loadTunnelProfileContent(workspaceRoot?: string): string | undefined {
  const profilePath = resolveTunnelProfilePath(workspaceRoot)
  if (!profilePath || !existsSync(profilePath)) {
    return undefined
  }
  return readFileSync(profilePath, "utf-8")
}

export function mergeOpencodeConfigLayers(
  ...layers: Array<string | undefined>
): string | undefined {
  const merged: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!layer?.trim()) continue
    deepMergeConfig(merged, parseJsoncObject(layer))
  }
  return Object.keys(merged).length > 0 ? JSON.stringify(merged, null, 2) : undefined
}

export function buildOpencodeConfigContent(existingContent: string | undefined, pluginUrl: string): string {
  const config = existingContent?.trim() ? parseJsoncObject(existingContent) : {}
  const existingPlugins = normalizePluginEntries(config.plugin)
  if (!existingPlugins.includes(pluginUrl)) {
    existingPlugins.push(pluginUrl)
  }
  return JSON.stringify(
    {
      "$schema": typeof config["$schema"] === "string" ? config["$schema"] : "https://opencode.ai/config.json",
      ...config,
      plugin: existingPlugins,
    },
    null,
    2,
  )
}

export function resolveExistingOpencodeConfigContent(userEnvironment: Record<string, unknown>): string | undefined {
  const userValue = normalizeConfigContentValue(userEnvironment.OPENCODE_CONFIG_CONTENT)
  if (userValue) {
    return userValue
  }
  return normalizeConfigContentValue(process.env.OPENCODE_CONFIG_CONTENT)
}

function toNpmFileSpecifier(filePath: string): string {
  return `${pluginPackageName}@file:${filePath.replace(/\\/g, "/")}`
}

function findPluginTarball(dir: string): string | null {
  if (!existsSync(dir)) {
    return null
  }

  const tarballs = readdirSync(dir)
    .filter((name) => name.endsWith(".tgz"))
    .sort()
  return tarballs.length > 0 ? path.resolve(dir, tarballs[tarballs.length - 1]) : null
}

function normalizeConfigContentValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function parseJsoncObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stripJsonc(content))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object")
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse OPENCODE_CONFIG_CONTENT: ${reason}`)
  }
}

function normalizePluginEntries(value: unknown): string[] {
  if (value === undefined) {
    return []
  }
  if (typeof value === "string") {
    return [value]
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value]
  }
  throw new Error("OPENCODE_CONFIG_CONTENT plugin field must be a string or string array")
}

function deepMergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      deepMergeConfig(existing as Record<string, unknown>, value as Record<string, unknown>)
      continue
    }
    target[key] = value
  }
}

function stripJsonc(input: string): string {
  let output = ""
  let inString = false
  let escape = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (escape) {
      output += char
      escape = false
      continue
    }

    if (char === "\\" && inString) {
      output += char
      escape = true
      continue
    }

    if (char === '"') {
      output += char
      inString = !inString
      continue
    }

    if (!inString && char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1
      }
      output += "\n"
      continue
    }

    if (!inString && char === "/" && next === "*") {
      index += 2
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        output += input[index] === "\n" ? "\n" : ""
        index += 1
      }
      index += 1
      continue
    }

    if (!inString && char === ",") {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead])) {
        lookahead += 1
      }
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue
      }
    }

    output += char
  }

  return output
}
