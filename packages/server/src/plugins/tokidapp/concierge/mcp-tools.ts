/**
 * MCP Tools — discovery and proxy for voice sessions.
 *
 * Reads opencode.json MCP server configuration, discovers available tools,
 * and proxies tool calls to the appropriate MCP server endpoint.
 *
 * Supported protocols:
 *  - remote HTTP/SSE: POST to URL with JSON-RPC style { name, params }
 *  - local stdio: spawn process and communicate via stdin/stdout JSON-RPC
 *
 * @module mcp-tools
 */

import fs from "fs"
import path from "path"

// ── Types ──────────────────────────────────────────────────────

export interface McpToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface McpServerConfig {
  type: "remote" | "local"
  url?: string
  command?: string[]
  enabled: boolean
  headers?: Record<string, string>
}

export interface McpToolResult {
  success: boolean
  result?: unknown
  error?: string
}

// ── Discovery ──────────────────────────────────────────────────

/** Cache of discovered tools per server. */
const toolCache = new Map<string, McpToolDefinition[]>()
const cacheTimestamp = new Map<string, number>()
const CACHE_TTL = 60_000 // 1 minute

/** Read the opencode.json MCP configuration. */
export function readMcpConfig(workspaceRoot: string): Record<string, McpServerConfig> {
  const configPath = path.join(workspaceRoot, "opencode.json")
  if (!fs.existsSync(configPath)) return {}
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    return config.mcp || {}
  } catch {
    return {}
  }
}

/**
 * List all available MCP servers that are enabled.
 */
export function listEnabledMcpServers(workspaceRoot: string): Array<{ id: string; config: McpServerConfig }> {
  const config = readMcpConfig(workspaceRoot)
  return Object.entries(config)
    .filter(([, cfg]) => cfg.enabled !== false)
    .map(([id, cfg]) => ({ id, config: cfg }))
}

/**
 * Discover tools from an MCP server.
 * For remote servers, attempts a tools/list JSON-RPC call.
 * For local stdio servers, spawns the process and calls tools/list.
 */
export async function discoverMcpTools(
  serverId: string,
  config: McpServerConfig,
  workspaceRoot: string,
): Promise<McpToolDefinition[]> {
  // Check cache first
  const cached = toolCache.get(serverId)
  const cachedAt = cacheTimestamp.get(serverId) || 0
  if (cached && Date.now() - cachedAt < CACHE_TTL) {
    return cached
  }

  try {
    if (config.type === "remote" && config.url) {
      const tools = await discoverRemoteMcpTools(config.url, config.headers)
      toolCache.set(serverId, tools)
      cacheTimestamp.set(serverId, Date.now())
      return tools
    }
    if (config.type === "local" && config.command) {
      // Local stdio discovery is expensive — do it once and cache
      const tools = await discoverLocalMcpTools(config.command, workspaceRoot)
      toolCache.set(serverId, tools)
      cacheTimestamp.set(serverId, Date.now())
      return tools
    }
  } catch (err) {
    console.warn(`[mcp-tools] Discovery failed for ${serverId}:`, (err as Error).message)
  }

  return []
}

async function discoverRemoteMcpTools(
  url: string,
  headers?: Record<string, string>,
): Promise<McpToolDefinition[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`MCP server returned ${response.status}`)
  }

  const data = await response.json()
  const tools = data?.result?.tools || data?.tools || []
  return tools.map((t: Record<string, unknown>) => ({
    name: String(t.name || ""),
    description: String(t.description || ""),
    parameters: t.inputSchema || t.parameters || { type: "object", properties: {} },
  }))
}

async function discoverLocalMcpTools(
  command: string[],
  workspaceRoot: string,
): Promise<McpToolDefinition[]> {
  // Local stdio discovery — spawn the MCP server and call tools/list
  // This is expensive, so we cache aggressively
  if (command.length < 2) return []

  const [cmd, ...args] = command
  // Only support bun/node-based commands for security
  if (cmd !== "bun" && cmd !== "node" && cmd !== "/Users/alexshapiro/starworld/.venv/bin/python3") {
    return []
  }

  try {
    const { spawn } = await import("child_process")
    const proc = spawn(cmd, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Send JSON-RPC initialize + tools/list
    const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n"
    const toolsMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"

    let stdout = ""
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })

    proc.stdin.write(initMsg)
    await new Promise((r) => setTimeout(r, 500))
    proc.stdin.write(toolsMsg)

    // Wait for response (max 5s)
    const result = await new Promise<McpToolDefinition[]>((resolve) => {
      const timer = setTimeout(() => { proc.kill(); resolve([]) }, 5000)
      proc.stdout.on("data", () => {
        const lines = stdout.split("\n").filter((l) => l.trim())
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.id === 2 && parsed.result?.tools) {
              clearTimeout(timer)
              proc.kill()
              resolve(parsed.result.tools.map((t: Record<string, unknown>) => ({
                name: String(t.name || ""),
                description: String(t.description || ""),
                parameters: t.inputSchema || { type: "object", properties: {} },
              })))
              return
            }
          } catch { /* not JSON */ }
        }
      })
    })

    return result
  } catch (err) {
    console.warn(`[mcp-tools] Local stdio discovery failed:`, (err as Error).message)
    return []
  }
}

/**
 * Convert MCP tool definitions to OpenAI Realtime tool format.
 */
export function mcpToolsToRealtimeFormat(
  serverId: string,
  tools: McpToolDefinition[],
): Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((tool) => ({
    type: "function",
    name: `mcp_${serverId}_${tool.name}`,
    description: `[MCP: ${serverId}] ${tool.description}`,
    parameters: tool.parameters,
  }))
}

// ── Proxy ──────────────────────────────────────────────────────

/**
 * Call an MCP tool by server ID and tool name.
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  params: Record<string, unknown>,
  workspaceRoot: string,
): Promise<McpToolResult> {
  const config = readMcpConfig(workspaceRoot)
  const serverConfig = config[serverId]

  if (!serverConfig || serverConfig.enabled === false) {
    return { success: false, error: `MCP server "${serverId}" not found or disabled` }
  }

  try {
    if (serverConfig.type === "remote" && serverConfig.url) {
      return await callRemoteMcpTool(serverConfig.url, toolName, params, serverConfig.headers)
    }
    if (serverConfig.type === "local" && serverConfig.command) {
      return await callLocalMcpTool(serverConfig.command, toolName, params, workspaceRoot)
    }
    return { success: false, error: `MCP server "${serverId}" has no valid configuration` }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function callRemoteMcpTool(
  url: string,
  toolName: string,
  params: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<McpToolResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: params },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    return { success: false, error: `MCP server returned ${response.status}: ${errorText}` }
  }

  const data = await response.json()
  if (data?.error) {
    return { success: false, error: String(data.error.message || data.error) }
  }

  return { success: true, result: data?.result || data }
}

async function callLocalMcpTool(
  command: string[],
  toolName: string,
  params: Record<string, unknown>,
  workspaceRoot: string,
): Promise<McpToolResult> {
  if (command.length < 2) return { success: false, error: "Invalid MCP command" }

  const [cmd, ...args] = command
  try {
    const { spawn } = await import("child_process")
    const proc = spawn(cmd, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n"
    const callMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: params } }) + "\n"

    let stdout = ""
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })

    proc.stdin.write(initMsg)
    await new Promise((r) => setTimeout(r, 500))
    proc.stdin.write(callMsg)

    const result = await new Promise<McpToolResult>((resolve) => {
      const timer = setTimeout(() => { proc.kill(); resolve({ success: false, error: "MCP call timed out" }) }, 15000)
      proc.stdout.on("data", () => {
        const lines = stdout.split("\n").filter((l) => l.trim())
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.id === 2) {
              clearTimeout(timer)
              proc.kill()
              if (parsed.error) {
                resolve({ success: false, error: String(parsed.error.message || parsed.error) })
              } else {
                resolve({ success: true, result: parsed.result })
              }
              return
            }
          } catch { /* not JSON */ }
        }
      })
    })

    return result
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

/** Clear the tool discovery cache. */
export function clearMcpToolCache(): void {
  toolCache.clear()
  cacheTimestamp.clear()
}
