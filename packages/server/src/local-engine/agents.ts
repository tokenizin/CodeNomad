/**
 * Finds a NomadWorks / OpenCode agent definition so Claude Code can run it.
 *
 * Claude Code takes custom agents as `--agents '{"name":{"description","prompt"}}'`
 * plus `--agent name`. OpenCode keeps them in opencode.json(c) under "agent"
 * (prompt inline or "{file:relative/path.md}") or as markdown files in
 * .opencode/agent(s)/<name>.md. This reads both shapes.
 */

import fs from "fs"
import os from "os"
import path from "path"
import { stripJsonc } from "../opencode-plugin.js"

export type ResolvedAgent = {
  name: string
  description: string
  prompt: string
  source: string
}

/** OpenCode's built-in agents. They have no Claude Code equivalent besides plan mode. */
export const OPENCODE_BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore"])

const AGENT_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function parseFrontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: markdown }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim()
  }
  return { meta, body: match[2] }
}

function resolvePrompt(raw: unknown, configDir: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const fileRef = raw.trim().match(/^\{file:(.+)\}$/)
  if (!fileRef) return raw
  const target = fileRef[1].trim()
  const expanded = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target
  const text = readText(path.resolve(configDir, expanded))
  return text ? parseFrontmatter(text).body.trim() || null : null
}

function fromConfigFile(configPath: string, name: string): ResolvedAgent | null {
  const content = readText(configPath)
  if (!content) return null
  let parsed: any
  try {
    parsed = JSON.parse(stripJsonc(content))
  } catch {
    return null
  }
  const entry = parsed?.agent?.[name]
  if (!entry || typeof entry !== "object" || entry.disable === true) return null
  const prompt = resolvePrompt(entry.prompt, path.dirname(configPath))
  if (!prompt) return null
  const description = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : name
  return { name, description, prompt, source: configPath }
}

function fromMarkdown(file: string, name: string): ResolvedAgent | null {
  const text = readText(file)
  if (!text) return null
  const { meta, body } = parseFrontmatter(text)
  if (!body.trim()) return null
  return { name, description: meta.description || name, prompt: body.trim(), source: file }
}

/** Config files to search, most specific first. */
export function agentConfigCandidates(cwd: string, extraConfigs: string[] = []): string[] {
  const list = [
    path.join(cwd, "opencode.jsonc"),
    path.join(cwd, "opencode.json"),
    path.join(cwd, ".opencode", "opencode.jsonc"),
    path.join(cwd, ".opencode", "opencode.json"),
    ...extraConfigs,
  ]
  return [...new Set(list.map((p) => path.resolve(p)))]
}

export function resolveNomadAgent(name: string, cwd: string, extraConfigs: string[] = []): ResolvedAgent | null {
  if (!AGENT_NAME.test(name)) return null

  for (const dir of ["agent", "agents"]) {
    const hit = fromMarkdown(path.join(cwd, ".opencode", dir, `${name}.md`), name)
    if (hit) return hit
  }
  for (const configPath of agentConfigCandidates(cwd, extraConfigs)) {
    const hit = fromConfigFile(configPath, name)
    if (hit) return hit
  }
  return null
}

/** True when Claude Code already knows this agent (project or user .claude/agents). */
export function hasClaudeAgentFile(name: string, cwd: string): boolean {
  if (!AGENT_NAME.test(name)) return false
  return [path.join(cwd, ".claude", "agents", `${name}.md`), path.join(os.homedir(), ".claude", "agents", `${name}.md`)].some(
    (file) => fs.existsSync(file),
  )
}
