/**
 * MCP Tools Helper — session-level MCP tool discovery and dispatch.
 *
 * Wraps the low-level mcp-tools.ts module with session-specific caching
 * and tool list assembly for OpenAI Realtime voice sessions.
 *
 * @module mcp-tools-helper
 */

import {
  listEnabledMcpServers,
  discoverMcpTools,
  mcpToolsToRealtimeFormat,
  callMcpTool,
  clearMcpToolCache,
} from "./mcp-tools"

export interface McpToolEntry {
  /** Full tool name sent to OpenAI: mcp__<server>_<tool> */
  fullName: string
  /** Server ID (e.g. "OpenZeppelinSolidityContracts") */
  serverId: string
  /** Original tool name from the MCP server */
  toolName: string
  /** OpenAI Realtime tool definition */
  definition: { type: "function"; name: string; description: string; parameters: Record<string, unknown> }
}

// ── Session-level cache ──────────────────────────────────────

interface SessionCache {
  tools: McpToolEntry[]
  discoveredAt: number
}

const sessionCache = new Map<string, SessionCache>()
const SESSION_CACHE_TTL = 120_000 // 2 minutes

/**
 * Discover and cache MCP tools for a session.
 * Returns the combined list of MCP tool entries.
 */
export async function discoverMcpToolsForSession(
  sessionId: string,
  workspaceRoot: string,
): Promise<McpToolEntry[]> {
  const cached = sessionCache.get(sessionId)
  if (cached && Date.now() - cached.discoveredAt < SESSION_CACHE_TTL) {
    return cached.tools
  }

  const servers = listEnabledMcpServers(workspaceRoot)
  const allTools: McpToolEntry[] = []

  for (const { id: serverId, config } of servers) {
    try {
      const tools = await discoverMcpTools(serverId, config, workspaceRoot)
      const realtimeTools = mcpToolsToRealtimeFormat(serverId, tools)
      for (const [i, def] of realtimeTools.entries()) {
        const originalToolName = tools[i]?.name || def.name.replace(/^mcp__.+?_/, "")
        allTools.push({
          fullName: def.name,
          serverId,
          toolName: originalToolName,
          definition: def,
        })
      }
    } catch (err) {
      console.warn(`[mcp-tools-helper] Discovery failed for ${serverId}:`, (err as Error).message)
    }
  }

  // Only cache if we found tools (avoid caching empty results from transient failures)
  if (allTools.length > 0) {
    sessionCache.set(sessionId, { tools: allTools, discoveredAt: Date.now() })
  }

  return allTools
}

/**
 * Check if a tool name is an MCP tool (starts with "mcp__").
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__")
}

/**
 * Parse an MCP tool name into server ID and tool name.
 * Format: mcp__<serverId>__<toolName>
 */
export function parseMcpToolName(fullName: string): { serverId: string; toolName: string } | null {
  if (!isMcpToolName(fullName)) return null
  const withoutPrefix = fullName.slice(5) // Remove "mcp__"
  const sepIndex = withoutPrefix.indexOf("__")
  if (sepIndex === -1) return {
    serverId: withoutPrefix,
    toolName: "",
  }
  return {
    serverId: withoutPrefix.slice(0, sepIndex),
    toolName: withoutPrefix.slice(sepIndex + 2),
  }
}

/**
 * Call an MCP tool by its full name.
 */
export async function callMcpToolDispatch(
  fullName: string,
  params: Record<string, unknown>,
  workspaceRoot: string,
): Promise<string> {
  const parsed = parseMcpToolName(fullName)
  if (!parsed) {
    return JSON.stringify({ success: false, error: `Invalid MCP tool name: ${fullName}` })
  }
  const result = await callMcpTool(parsed.serverId, parsed.toolName, params, workspaceRoot)
  return JSON.stringify(result)
}

/**
 * Get all MCP tool definitions in OpenAI Realtime format for a session.
 * Returns an array suitable for spreading into the tools array.
 */
export async function getMcpToolDefinitions(
  sessionId: string,
  workspaceRoot: string,
): Promise<Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }>> {
  const tools = await discoverMcpToolsForSession(sessionId, workspaceRoot)
  return tools.map((t) => t.definition)
}

/**
 * Invalidate the MCP tool cache for a session.
 */
export function invalidateMcpCache(sessionId?: string): void {
  if (sessionId) {
    sessionCache.delete(sessionId)
  } else {
    sessionCache.clear()
    clearMcpToolCache()
  }
}
