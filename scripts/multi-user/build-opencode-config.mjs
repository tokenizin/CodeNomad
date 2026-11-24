#!/usr/bin/env node
// Build a per-user global OpenCode config (models + agents) for a per-person CodeNomad instance.
//
// OpenCode reads the open workspace's .opencode/ and the user's ~/.config/opencode/. A second macOS user
// has neither, so their model and agent pickers are empty. This copies the shared parts of an existing
// config into the target folder:
//   - provider: only "ollama", pointed at the shared host Ollama, with models listed live from /api/tags
//     (falls back to the source config's list if Ollama is unreachable). Providers that need API keys
//     or the owner's local proxies are dropped.
//   - agent: every agent whose {file:...} prompt resolves; prompts are copied into <target>/prompts/.
//     Agents pinned to a non-Ollama model fall back to the default model.
//   - instructions are dropped (they point at repo-specific rules such as CodeNomad's AGENTS.md).
//
// Usage: node build-opencode-config.mjs --source <opencode.jsonc> --target <dir> [--ollama http://127.0.0.1:11434]
import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const args = { ollama: "http://127.0.0.1:11434" }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "")
    if (!key || argv[i + 1] === undefined) throw new Error(`Missing value for ${argv[i]}`)
    args[key] = argv[i + 1]
  }
  if (!args.source || !args.target) throw new Error("Usage: --source <opencode.jsonc> --target <dir> [--ollama <url>]")
  return args
}

/** Strip // and /* *\/ comments and trailing commas without touching string contents (URLs contain //). */
export function parseJsonc(text) {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === "\\") { out += next ?? ""; i++ } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue }
    if (ch === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue }
    out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

async function listOllamaModels(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const body = await res.json()
    return (body.models ?? []).map((m) => m.name).filter(Boolean)
  } catch {
    return null
  }
}

const FILE_REF = /^\{file:(.+)\}$/

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourcePath = path.resolve(args.source)
  const sourceDir = path.dirname(sourcePath)
  const targetDir = path.resolve(args.target)
  const source = parseJsonc(fs.readFileSync(sourcePath, "utf8"))

  const sourceOllama = source.provider?.ollama ?? {}
  const live = await listOllamaModels(args.ollama)
  const modelIds = live ?? Object.keys(sourceOllama.models ?? {})
  const models = Object.fromEntries(modelIds.map((id) => [id, sourceOllama.models?.[id] ?? { name: id }]))
  const configuredDefault = typeof source.model === "string" ? source.model.replace(/^ollama\//, "") : ""
  const defaultModel = modelIds.includes(configuredDefault) ? configuredDefault : modelIds[0]

  fs.mkdirSync(path.join(targetDir, "prompts"), { recursive: true })
  const agents = {}
  const skipped = []
  for (const [name, agent] of Object.entries(source.agent ?? {})) {
    const next = { ...agent }
    const ref = typeof agent.prompt === "string" ? agent.prompt.match(FILE_REF) : null
    if (ref) {
      const promptPath = path.resolve(sourceDir, ref[1])
      if (!fs.existsSync(promptPath)) { skipped.push(`${name} (prompt not found: ${promptPath})`); continue }
      const copied = `${name}.md`
      fs.copyFileSync(promptPath, path.join(targetDir, "prompts", copied))
      next.prompt = `{file:prompts/${copied}}`
    }
    if (typeof next.model === "string" && !(next.model.startsWith("ollama/") && modelIds.includes(next.model.slice(7)))) {
      delete next.model
    }
    agents[name] = next
  }

  const config = {
    $schema: "https://opencode.ai/config.json",
    ...(defaultModel ? { model: `ollama/${defaultModel}` } : {}),
    provider: {
      ollama: {
        npm: sourceOllama.npm ?? "@ai-sdk/openai-compatible",
        name: "Ollama (shared)",
        options: { baseURL: `${args.ollama.replace(/\/+$/, "")}/v1` },
        models,
      },
    },
    agent: agents,
  }
  const targetFile = path.join(targetDir, "opencode.jsonc")
  fs.writeFileSync(targetFile, `${JSON.stringify(config, null, 2)}\n`)

  console.log(`Wrote ${targetFile}`)
  console.log(`  models: ${modelIds.length} from ${live ? "live Ollama" : "source config (Ollama unreachable)"}; default ollama/${defaultModel ?? "(none)"}`)
  console.log(`  agents: ${Object.keys(agents).length} copied${skipped.length ? `, ${skipped.length} skipped:` : ""}`)
  for (const line of skipped) console.log(`    - ${line}`)
}

// Run only when executed directly, so other scripts can import parseJsonc without triggering a build.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
