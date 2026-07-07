/**
 * Commands Router — parses user input for commands, @mentions, [directives],
 * pipeline syntax, and slash commands. Resolves them against the command
 * registry and produces structured action plans.
 *
 * Supports:
 *   /command args              — slash commands (direct action)
 *   @agent_name directive      — agent mentions (route to agent)
 *   [A → B: action]            — directive syntax (agent-to-agent workflow)
 *   A | B | C                  — pipeline syntax (sequential steps)
 *   #tag                       — metadata/labels
 *
 * Integrated with:
 *   - command-registry.ts (agent + command definitions)
 *   - openai-realtime.ts (voice tool handler)
 *   - tokidapp.ts (text chat handler)
 *   - nomadworks-bridge.ts (task file bridge)
 *
 * @module commands-router
 */

import { findAgent, findCommand, resolveAgentName, type ProcessDirective } from "./command-registry"

// ── Parse Results ──────────────────────────────────────────────

export interface ParsedCommand {
  type: "slash_command" | "agent_mention" | "directive" | "pipeline" | "tag" | "text"
  /** Raw matched text */
  raw: string
  /** For slash_command: command name (without /) */
  command?: string
  /** For slash_command: arguments after command */
  args?: string
  /** For agent_mention: resolved canonical agent name */
  agentName?: string
  /** For agent_mention: the directive/instruction following @agent */
  directive?: string
  /** For directive: structured process directive */
  processDirective?: ProcessDirective
  /** For pipeline: individual pipeline steps */
  pipelineSteps?: string[]
  /** For tag: the tag name (without #) */
  tag?: string
}

export interface ParseResult {
  /** All parsed items in order */
  items: ParsedCommand[]
  /** The plain text with all commands stripped */
  cleanText: string
  /** Whether any commands were found */
  hasCommands: boolean
  /** Extracted tags */
  tags: string[]
}

// ── Regex Patterns ─────────────────────────────────────────────

// Slash command: /command [args...] at start or after whitespace
const SLASH_PATTERN = /(?:^|\s)\/([\w-]+(?:\.[\w-]+)?)(?:\s+(.+?))?(?=\s*$|\s+(?:\/|@|\[|#)|\s*$)/g

// @mention: @agent_name or @agent.name at start or after whitespace
const MENTION_PATTERN = /(?:^|\s)@([\w-]+(?:\.[\w-]+)?)(?:\s+(.*?))?(?=\s*$|\s*@|\s*\/|\s*\[|\s*#)/g

// Directive: [AgentA → AgentB: action target] or [AgentB: action target]
const DIRECTIVE_PATTERN = /\[([\w-]+(?:\.[\w-]+)?)(?:\s*(?:→|->|=>|-->|:)\s*([\w-]+(?:\.[\w-]+)?))?\s*:\s*([^\[\]]+?)\s*\]/g

// Pipeline: step1 | step2 | step3
const PIPELINE_PATTERN = /([\w-]+(?:\.[\w-]+)?(?:\s+[^|]+?))\s*\|\s*/g

// Tag: #tag_name at word boundary
const TAG_PATTERN = /(?:^|\s)#([\w-]+)/g

// ── Parser ─────────────────────────────────────────────────────

/**
 * Parse user input for all supported command syntaxes.
 * Returns structured items plus the cleaned text.
 *
 * Examples:
 *   "/deploy vercel" → [{type: "slash_command", command: "deploy", args: "vercel"}]
 *   "@developer fix the login" → [{type: "agent_mention", agentName: "developer", directive: "fix the login"}]
 *   "[BA → Dev: implement SCR-007]" → [{type: "directive", processDirective: {from: "BA", to: "Dev", action: "implement SCR-007"}}]
 *   "investigate | implement | verify" → [{type: "pipeline", pipelineSteps: ["investigate", "implement", "verify"]}]
 *   "#urgent #blocked deploy fix" → [{type: "tag", tag: "urgent"}, {type: "tag", tag: "blocked"}, {type: "text", raw: "deploy fix"}]
 */
export function parseInput(input: string): ParseResult {
  const items: ParsedCommand[] = []
  const tags: string[] = []
  let cleanText = input

  // 1. Extract tags (#tag)
  const tagMatches = [...input.matchAll(TAG_PATTERN)]
  for (const match of tagMatches) {
    const tag = match[1].toLowerCase()
    tags.push(tag)
    items.push({ type: "tag", raw: match[0].trim(), tag })
    cleanText = cleanText.replace(match[0], "")
  }

  // 2. Extract directives ([A → B: action])
  const directiveMatches = [...input.matchAll(DIRECTIVE_PATTERN)]
  for (const match of directiveMatches) {
    const from = match[1] ? resolveAgentName(match[1]) : undefined
    const to = match[2] ? resolveAgentName(match[2]) || match[2] : resolveAgentName(match[1]) || match[1]
    const actionText = match[3].trim()

    // Parse action and target from the action text
    const actionParts = actionText.match(/^(\w+)(?:\s+(.+))?$/)
    const action = actionParts?.[1] || actionText
    const target = actionParts?.[2]

    const pd: ProcessDirective = {
      from: from || match[1],
      to: to || match[1],
      action,
      target,
      raw: match[0],
    }

    items.push({
      type: "directive",
      raw: match[0],
      processDirective: pd,
    })
    cleanText = cleanText.replace(match[0], "")
  }

  // 3. Extract @mentions
  const mentionMatches = [...input.matchAll(MENTION_PATTERN)]
  for (const match of mentionMatches) {
    const agentName = resolveAgentName(match[1]) || match[1]
    items.push({
      type: "agent_mention",
      raw: match[0].trim(),
      agentName,
      directive: match[2]?.trim(),
    })
    cleanText = cleanText.replace(match[0], "")
  }

  // 4. Extract slash commands
  const slashMatches = [...input.matchAll(SLASH_PATTERN)]
  for (const match of slashMatches) {
    const cmd = findCommand(match[1])
    items.push({
      type: "slash_command",
      raw: match[0].trim(),
      command: cmd?.name || match[1],
      args: match[2]?.trim(),
    })
    cleanText = cleanText.replace(match[0], "")
  }

  // 5. Detect pipeline syntax (step | step | step)
  const pipelineMatch = input.match(PIPELINE_PATTERN)
  if (pipelineMatch || input.includes("|")) {
    const steps = input
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("/") && !s.startsWith("@") && !s.startsWith("["))
    if (steps.length >= 2) {
      // Only add pipeline if we didn't already extract everything as other types
      const nonPipelineItems = items.filter((i) => i.type !== "pipeline")
      if (nonPipelineItems.length === 0 || steps.length > nonPipelineItems.length) {
        items.push({
          type: "pipeline",
          raw: input,
          pipelineSteps: steps,
        })
        cleanText = ""
      }
    }
  }

  // Clean up remaining whitespace
  cleanText = cleanText.replace(/\s+/g, " ").trim()

  // If nothing was parsed and there's remaining text, add as plain text
  if (cleanText && items.length === 0) {
    items.push({ type: "text", raw: cleanText })
  } else if (cleanText) {
    items.push({ type: "text", raw: cleanText })
  }

  return {
    items,
    cleanText,
    hasCommands: items.length > 0 && items.some((i) => i.type !== "text"),
    tags,
  }
}

// ── Action Resolution ──────────────────────────────────────────

export interface ResolvedAction {
  /** The primary action type */
  actionType: "route_to_agent" | "execute_command" | "run_pipeline" | "dispatch_directive" | "respond_text" | "load_skill"
  /** Target agent name (if routing to agent) */
  targetAgent?: string
  /** Command name (if executing a command) */
  commandName?: string
  /** Arguments for the command */
  commandArgs?: string
  /** Process directive (if dispatch) */
  processDirective?: ProcessDirective
  /** Pipeline steps */
  pipelineSteps?: string[]
  /** The instruction/directive text */
  instruction?: string
  /** Whether this requires confirmation */
  requiresConfirmation?: boolean
  /** Confidence in this resolution (0-1) */
  confidence: number
}

/**
 * Resolve parsed commands into executable actions.
 * Determines whether to route to an agent, execute a command, run a pipeline, etc.
 */
export function resolveActions(parseResult: ParseResult): ResolvedAction[] {
  const actions: ResolvedAction[] = []

  for (const item of parseResult.items) {
    switch (item.type) {
      case "agent_mention": {
        // Route to agent with directive
        const agent = findAgent(item.agentName || "")
        actions.push({
          actionType: "route_to_agent",
          targetAgent: item.agentName,
          instruction: item.directive || parseResult.cleanText,
          confidence: agent ? 0.95 : 0.6,
        })
        break
      }

      case "slash_command": {
        const cmd = findCommand(item.command || "")
        actions.push({
          actionType: "execute_command",
          commandName: item.command,
          commandArgs: item.args,
          requiresConfirmation: cmd?.requiresConfirmation,
          confidence: cmd ? 0.95 : 0.5,
        })
        break
      }

      case "directive": {
        const pd = item.processDirective!
        const fromAgent = findAgent(pd.from || "")
        const toAgent = findAgent(pd.to)

        actions.push({
          actionType: "dispatch_directive",
          targetAgent: pd.to,
          processDirective: pd,
          instruction: `${pd.action}${pd.target ? ` ${pd.target}` : ""}`,
          confidence: toAgent ? 0.95 : 0.5,
        })

        // If source agent is PMA and target is a subagent, mark as delegation
        if (fromAgent?.name === "product_manager" && toAgent && !toAgent.isPrimary) {
          actions[actions.length - 1].confidence = 1.0
        }
        break
      }

      case "pipeline": {
        actions.push({
          actionType: "run_pipeline",
          pipelineSteps: item.pipelineSteps,
          confidence: 0.85,
        })
        break
      }

      case "tag": {
        // Tags are metadata — no direct action, but influence context
        break
      }

      case "text": {
        // Plain text — treat as a general instruction
        // Check if it starts with a skill name
        const skillMatch = item.raw.match(/^(?:load|run|use)\s+(\w[\w-]*)\s*(.+)?$/i)
        if (skillMatch) {
          actions.push({
            actionType: "load_skill",
            commandName: skillMatch[1],
            commandArgs: skillMatch[2],
            confidence: 0.7,
          })
        }
        break
      }
    }
  }

  // If no concrete actions were resolved, treat cleanText as a response request
  if (actions.length === 0 && parseResult.cleanText) {
    actions.push({
      actionType: "respond_text",
      instruction: parseResult.cleanText,
      confidence: 0.5,
    })
  }

  return actions
}

// ── Format Helpers ─────────────────────────────────────────────
// For displaying parsed commands back to the user or in voice.

/**
 * Format the parse result as a human-readable summary (for voice/chat).
 */
export function formatParseSummary(parseResult: ParseResult): string {
  const parts: string[] = []
  for (const item of parseResult.items) {
    switch (item.type) {
      case "slash_command":
        parts.push(`command: /${item.command}${item.args ? ` ${item.args}` : ""}`)
        break
      case "agent_mention":
        parts.push(`route to @${item.agentName}${item.directive ? `: "${item.directive}"` : ""}`)
        break
      case "directive":
        parts.push(`directive: ${item.processDirective?.from || "?"} → ${item.processDirective?.to}: ${item.processDirective?.action}`)
        break
      case "pipeline":
        parts.push(`pipeline: ${item.pipelineSteps?.join(" → ")}`)
        break
      case "tag":
        parts.push(`tag: #${item.tag}`)
        break
    }
  }
  return parts.length > 0 ? parts.join("; ") : "(no commands)"
}
