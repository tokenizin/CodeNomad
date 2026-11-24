#!/usr/bin/env node
// Migrate an admin's whole OpenCode setup (models, agents, subagents, plugins, MCP servers, commands,
// skills, tools) into another macOS user's global ~/.config/opencode, for a per-person CodeNomad.
//
// OpenCode reads ~/.config/opencode plus the open project's .opencode/. A second user has neither, so their
// CodeNomad shows no models or agents. This script, run as root on the Mac:
//   1. discovers the admin's config layers (global → ~/starworld → ~/starworld/CodeNomad, OpenCode's
//      own precedence: later layers override earlier ones) plus any --source you add;
//   2. deep-merges them (plugin/instructions arrays are unioned);
//   3. copies every {file:...} prompt and every instructions file into the target and rewrites the
//      references to absolute target paths, so nothing points into the admin's home;
//   4. copies the auto-loaded folders (agent(s)/, command(s)/, plugin(s)/, skill(s)/, tool(s)/, mode(s)/,
//      themes/) from each layer;
//   5. by default REMOVES literal credentials (API keys, tokens, auth headers, MCP secret env values) and
//      lists them; --with-secrets keeps them and also copies the admin's OpenCode auth.json;
//   6. reports {env:VAR} references the user's environment must provide and strings that still name the
//      admin's home (e.g. local MCP server commands), which the user may not be able to read.
//
// Usage: node migrate-opencode-setup.mjs --admin-home /Users/alex --target /Users/stas/.config/opencode
//        [--source <dir-or-opencode.json> ...] [--with-secrets] [--dry-run]
import fs from "node:fs"
import path from "node:path"

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc", "config.json"]
const ASSET_DIRS = ["agent", "agents", "command", "commands", "plugin", "plugins", "skill", "skills", "tool", "tools", "mode", "modes", "themes"]
const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|bearer|credential|private[-_]?key|cookie)/i
const SECRET_VALUE = /^(sk-[A-Za-z0-9_-]{10,}|sk_live_|ghp_|gho_|github_pat_|xox[abpr]-|nvapi-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+\S{12,}|eyJ[A-Za-z0-9_-]{10,}\.)/
const ENV_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const FILE_REF = /\{file:([^}]+)\}/g

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

function parseArgs(argv) {
  const args = { sources: [], withSecrets: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--with-secrets") args.withSecrets = true
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "--source") args.sources.push(argv[++i])
    else if (a === "--admin-home") args.adminHome = argv[++i]
    else if (a === "--target") args.target = argv[++i]
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!args.adminHome || !args.target) {
    throw new Error("Usage: --admin-home <dir> --target <dir> [--source <path> ...] [--with-secrets] [--dry-run]")
  }
  return args
}

/** A layer is a folder that may hold an opencode config file and/or auto-loaded asset folders. */
function discoverLayers(adminHome, extra) {
  const candidates = [
    path.join(adminHome, ".config/opencode"),
    path.join(adminHome, "starworld"),
    path.join(adminHome, "starworld/.opencode"),
    path.join(adminHome, "starworld/CodeNomad"),
    path.join(adminHome, "starworld/CodeNomad/.opencode"),
    ...extra.map((p) => path.resolve(p)),
  ]
  const layers = []
  for (const candidate of candidates) {
    const isFile = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    const dir = isFile ? path.dirname(candidate) : candidate
    if (!fs.existsSync(dir)) continue
    const configFiles = isFile ? [candidate] : CONFIG_NAMES.map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f))
    // Asset folders only count inside OpenCode config folders, not in a project root like ~/starworld.
    const isConfigFolder = path.basename(dir) === ".opencode" || dir === path.join(adminHome, ".config/opencode")
    const assets = isConfigFolder ? ASSET_DIRS.filter((d) => fs.existsSync(path.join(dir, d)) && fs.statSync(path.join(dir, d)).isDirectory()) : []
    if (configFiles.length || assets.length) layers.push({ dir, configFiles, assets })
  }
  return layers
}

function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v) }

function deepMerge(base, over, key = "") {
  if (Array.isArray(base) && Array.isArray(over) && (key === "plugin" || key === "instructions")) {
    return [...new Set([...base, ...over])]
  }
  if (!isObject(base) || !isObject(over)) return over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v, k) : v
  return out
}

/** Copy a referenced file into <target>/<bucket>/ under a collision-free name; return its absolute target path. */
function importFile(state, absSource, bucket) {
  if (state.imported.has(absSource)) return state.imported.get(absSource)
  const rel = path.relative(state.adminHome, absSource)
  const name = (rel.startsWith("..") ? path.basename(absSource) : rel).replace(/^\.+/, "").replace(/[\\/]+/g, "__")
  const dest = path.join(state.target, bucket, name)
  if (!state.dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(absSource, dest)
  }
  state.imported.set(absSource, dest)
  return dest
}

function expandHome(p, home) { return p.startsWith("~/") ? path.join(home, p.slice(2)) : p }

/** Rewrite {file:...} refs in one layer's config to copied files (relative refs resolve against that config's folder). */
function rewriteFileRefs(value, configDir, state, trail) {
  if (typeof value === "string") {
    return value.replace(FILE_REF, (whole, ref) => {
      const abs = path.resolve(configDir, expandHome(ref.trim(), state.adminHome))
      if (!fs.existsSync(abs)) { state.report.missingFiles.push(`${trail}: ${abs}`); return whole }
      return `{file:${importFile(state, abs, "prompts")}}`
    })
  }
  if (Array.isArray(value)) return value.map((v, i) => rewriteFileRefs(v, configDir, state, `${trail}[${i}]`))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteFileRefs(v, configDir, state, trail ? `${trail}.${k}` : k)]))
  return value
}

function rewriteInstructions(list, configDir, state) {
  return list.map((entry) => {
    if (typeof entry !== "string" || /^https?:/.test(entry) || /[*?]/.test(entry)) return entry
    const abs = path.resolve(configDir, expandHome(entry, state.adminHome))
    if (!fs.existsSync(abs)) { state.report.missingFiles.push(`instructions: ${abs}`); return entry }
    return importFile(state, abs, "instructions")
  })
}

/** Remove (or, with --with-secrets, keep and list) literal credentials; collect env refs and admin-home paths. */
function scrub(value, state, trail, keyName = "") {
  if (typeof value === "string") {
    for (const m of value.matchAll(ENV_REF)) state.report.envVars.add(m[1])
    // "${VAR}" is a placeholder, not a credential, but OpenCode only expands {env:VAR}: keep it and flag it.
    const shellPlaceholder = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
    if (shellPlaceholder) {
      state.report.shellPlaceholders.push(`${trail}: \${${shellPlaceholder[1]}} (OpenCode only expands {env:${shellPlaceholder[1]}})`)
      return value
    }
    const literal = !/^\{env:[^}]+\}$/.test(value.trim()) && value.trim().length > 0
    const secret = literal && (SECRET_VALUE.test(value.trim()) || (SECRET_KEY.test(keyName) && value.trim().length >= 8))
    if (secret) {
      state.report.secrets.push(trail)
      return state.withSecrets ? value : undefined
    }
    if (value.includes(state.adminHome)) state.report.adminPaths.push(`${trail}: ${value}`)
    return value
  }
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, state, `${trail}[${i}]`, keyName))
  if (isObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const next = scrub(v, state, trail ? `${trail}.${k}` : k, k)
      if (next !== undefined) out[k] = next
    }
    return out
  }
  return value
}

function copyTree(src, dest, state) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to, state)
    else if (entry.isFile()) {
      state.report.assetFiles++
      if (!state.dryRun) { fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(from, to) }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const adminHome = path.resolve(args.adminHome)
  const target = path.resolve(args.target)
  const state = {
    adminHome, target, dryRun: args.dryRun, withSecrets: args.withSecrets, imported: new Map(),
    report: { secrets: [], envVars: new Set(), shellPlaceholders: [], adminPaths: [], missingFiles: [], assetFiles: 0 },
  }

  const layers = discoverLayers(adminHome, args.sources)
  if (layers.length === 0) throw new Error(`No OpenCode config found under ${adminHome}`)

  let merged = {}
  for (const layer of layers) {
    for (const file of layer.configFiles) {
      let config = parseJsonc(fs.readFileSync(file, "utf8"))
      if (Array.isArray(config.instructions)) config.instructions = rewriteInstructions(config.instructions, path.dirname(file), state)
      config = rewriteFileRefs(config, path.dirname(file), state, "")
      merged = deepMerge(merged, config)
    }
    for (const dir of layer.assets) copyTree(path.join(layer.dir, dir), path.join(target, dir), state)
  }
  merged = scrub(merged, state, "")
  merged.$schema = "https://opencode.ai/config.json"

  const targetFile = path.join(target, "opencode.json")
  if (!args.dryRun) {
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(targetFile, `${JSON.stringify(merged, null, 2)}\n`)
  }

  let authCopied = false
  const adminAuth = path.join(adminHome, ".local/share/opencode/auth.json")
  if (args.withSecrets && fs.existsSync(adminAuth) && !args.dryRun) {
    const userHome = path.resolve(target, "../..")
    const dest = path.join(userHome, ".local/share/opencode/auth.json")
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(adminAuth, dest)
    fs.chmodSync(dest, 0o600)
    authCopied = true
  }

  const r = state.report
  const count = (o) => (isObject(o) ? Object.keys(o).length : 0)
  console.log(`${args.dryRun ? "[dry run] Would write" : "Wrote"} ${targetFile}`)
  console.log("  layers merged (lowest → highest precedence):")
  for (const l of layers) console.log(`    - ${l.dir}${l.configFiles.length ? ` [${l.configFiles.map((f) => path.basename(f)).join(", ")}]` : ""}${l.assets.length ? ` + ${l.assets.join("/, ")}/` : ""}`)
  console.log(`  providers: ${count(merged.provider)} (${Object.keys(merged.provider ?? {}).join(", ") || "none"})`)
  console.log(`  agents/subagents in config: ${count(merged.agent)} · mcp servers: ${count(merged.mcp)} (${Object.keys(merged.mcp ?? {}).join(", ") || "none"})`)
  console.log(`  plugins: ${(merged.plugin ?? []).length} · commands: ${count(merged.command)} · default model: ${merged.model ?? "(none)"}`)
  console.log(`  files copied: ${state.imported.size} referenced prompts/instructions, ${r.assetFiles} from asset folders`)
  if (r.secrets.length) {
    console.log(`  credentials ${args.withSecrets ? "COPIED (you passed --with-secrets)" : "REMOVED (re-run with --with-secrets to copy them)"}:`)
    for (const s of r.secrets) console.log(`    - ${s}`)
  }
  if (args.withSecrets) console.log(`  OpenCode auth.json: ${authCopied ? "copied (provider logins shared)" : "not found / not copied"}`)
  if (r.envVars.size) console.log(`  environment variables the user's CodeNomad must provide: ${[...r.envVars].sort().join(", ")}`)
  if (r.shellPlaceholders.length) {
    console.log("  kept as-is, but OpenCode sends these literally (same for the admin today):")
    for (const p of r.shellPlaceholders) console.log(`    - ${p}`)
  }
  if (r.adminPaths.length) {
    console.log("  still pointing into the admin's home (the user may not be able to read these):")
    for (const p of r.adminPaths) console.log(`    - ${p}`)
  }
  if (r.missingFiles.length) {
    console.log("  referenced files not found (left as-is):")
    for (const m of r.missingFiles) console.log(`    - ${m}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
