/**
 * Command Registry — centralized catalog of all commands, agents, skills, and tools
 * available across the NomadWorks ecosystem.
 *
 * This registry is single source of truth for:
 * - Slash commands (/commit, /test, /deploy, etc.)
 * - Agent mentions (@developer, @PMA, etc.)
 * - Directive syntax ([A → B: action])
 * - Skill names (for skill() loader)
 * - Tool names (from Realtime tools, MCP servers, NomadWorks tools)
 * - Pipeline syntax (A | B | C)
 *
 * @module command-registry
 */

// ── Agent Registry ─────────────────────────────────────────────
// All NomadWorks agent names + aliases. Used for @mentions and [A→B] syntax.

export interface AgentEntry {
  /** Canonical agent name (lowercase, no spaces) */
  name: string
  /** Human-readable aliases */
  aliases: string[]
  /** Short role description */
  role: string
  /** Whether this agent is a primary (orchestrator-level) vs subagent */
  isPrimary: boolean
  /** Agents this agent commonly delegates to */
  canDelegateTo?: string[]
}

export const AGENT_REGISTRY: AgentEntry[] = [
  // ── C-Level Executives (Primary) ──
  {
    name: "ceo",
    aliases: ["chief", "executive"],
    role: "Ecosystem vision, risk management, strategic decisions",
    isPrimary: true,
    canDelegateTo: ["cto", "cfo", "cmo", "cso", "cao", "coo"],
  },
  {
    name: "cto",
    aliases: ["tech", "technology"],
    role: "Technology strategy, architecture decisions, technical risk",
    isPrimary: true,
    canDelegateTo: ["technical_architect", "solidity-architect", "infra_sme"],
  },
  {
    name: "cmo",
    aliases: ["marketing", "brand"],
    role: "Brand strategy, campaign execution, dApp UI governance",
    isPrimary: true,
  },
  {
    name: "cso",
    aliases: ["security"],
    role: "Smart contract audit governance, incident response, threat modeling",
    isPrimary: true,
    canDelegateTo: ["contract_security_auditor"],
  },
  {
    name: "cfo",
    aliases: ["finance", "treasury"],
    role: "Treasury management, tokenomics, budget allocation, investor reporting",
    isPrimary: true,
  },
  {
    name: "cao",
    aliases: ["acquisition", "partnerships"],
    role: "Merchant acquisition, venue onboarding, partner growth",
    isPrimary: true,
    canDelegateTo: ["venue_operations_manager"],
  },
  {
    name: "coo",
    aliases: ["operations", "operating"],
    role: "Merchant event execution, venue operations, staff coordination, gate decisions",
    isPrimary: true,
    canDelegateTo: ["venue_operations_manager", "dev_ops"],
  },

  // ── Orchestrator (Primary) ──
  {
    name: "product_manager",
    aliases: ["pm", "pma", "manager", "orchestrator"],
    role: "Central orchestrator — task assignment, workflow management, agent coordination",
    isPrimary: true,
    canDelegateTo: [
      "business_analyst", "tech_lead", "technical_architect",
      "developer", "qa_engineer", "ui_ux_designer", "mui_engineer",
      "workflow_runner", "delivery_manager",
    ],
  },

  // ── Core Specialists (Subagent) ──
  {
    name: "business_analyst",
    aliases: ["ba", "analyst", "requirements"],
    role: "Document steward, requirements analysis, specification authoring",
    isPrimary: false,
  },
  {
    name: "tech_lead",
    aliases: ["tl", "lead"],
    role: "Technical leadership, code quality, architectural adherence, verification",
    isPrimary: false,
  },
  {
    name: "technical_architect",
    aliases: ["architect", "ta"],
    role: "Technical interfaces, architectural patterns, consistency enforcement",
    isPrimary: false,
  },
  {
    name: "delivery_manager",
    aliases: ["delivery", "dm"],
    role: "Delivery tracking, release management, sprint coordination, quality gates",
    isPrimary: false,
  },

  // ── Implementation Specialists (Subagent) ──
  {
    name: "developer",
    aliases: ["dev", "coder", "implementer"],
    role: "Feature implementation, test writing, code changes",
    isPrimary: false,
  },
  {
    name: "qa_engineer",
    aliases: ["qa", "tester", "test"],
    role: "Test suite design, execution, validation, manual verification",
    isPrimary: false,
  },
  {
    name: "ui_ux_designer",
    aliases: ["designer", "ui", "ux"],
    role: "UI/UX design, neuro-inclusive accessibility, visual review",
    isPrimary: false,
  },
  {
    name: "mui_engineer",
    aliases: ["mui", "material"],
    role: "MUI component development, design critique, accessibility enforcement",
    isPrimary: false,
  },
  {
    name: "workflow_runner",
    aliases: ["runner", "executor"],
    role: "Delegated workflow execution, multi-step task orchestration",
    isPrimary: false,
  },

  // ── Infrastructure (Subagent) ──
  {
    name: "infra_sme",
    aliases: ["infrastructure", "infra"],
    role: "Platform topology, CI/CD, multi-regional architecture, FinOps",
    isPrimary: false,
  },
  {
    name: "dev_ops",
    aliases: ["devops", "ops"],
    role: "CI/CD execution, deployments, schema ops, multi-stack automation",
    isPrimary: false,
  },

  // ── Solidity & EVM (Primary + Subagent) ──
  {
    name: "solidity-architect",
    aliases: ["solidity", "evm", "contracts"],
    role: "Smart contract design, OpenZeppelin, upgradeable patterns, ERC-4337",
    isPrimary: true,
    canDelegateTo: ["contract_security_auditor", "evm_optimization_engineer", "upgrade_specialist"],
  },
  {
    name: "contract_security_auditor",
    aliases: ["auditor", "security-auditor"],
    role: "Vulnerability assessment, risk analysis, security verification",
    isPrimary: false,
  },
  {
    name: "evm_optimization_engineer",
    aliases: ["optimizer", "gas"],
    role: "Gas optimization, contract efficiency, deployment cost reduction",
    isPrimary: false,
  },
  {
    name: "upgrade_specialist",
    aliases: ["upgrader", "proxy"],
    role: "Upgradeable contracts, storage layout, proxy safety",
    isPrimary: false,
  },

  // ── Venue Operations (Subagent) ──
  {
    name: "venue_operations_manager",
    aliases: ["venue-ops", "vom"],
    role: "Day-to-day venue operations, event execution, staff training, member support",
    isPrimary: false,
  },

  // ── Compliance (Subagent) ──
  {
    name: "frontend_compliance_agent",
    aliases: ["compliance", "frontend-compliance"],
    role: "Redux/Zustand SSOT enforcement, React best practices",
    isPrimary: false,
  },

  // ── OpenCode Base Agents (Subagent) ──
  {
    name: "opencoder",
    aliases: ["oc", "coder"],
    role: "Complex coding, architecture, multi-file refactoring",
    isPrimary: true,
  },
  {
    name: "openagent",
    aliases: ["agent", "general"],
    role: "Universal queries, tasks, cross-domain coordination",
    isPrimary: true,
  },
]

// ── Slash Commands Registry ────────────────────────────────────
// Maps command names → handler info. Supports aliasing.

export interface CommandEntry {
  /** Canonical command name (without /) */
  name: string
  /** Alternative names */
  aliases: string[]
  /** Category for help grouping */
  category: "project" | "agent" | "sidecar" | "solidity" | "orchestration" | "obsidian" | "skill" | "tool"
  /** Short description */
  description: string
  /** Usage hint */
  usage?: string
  /** Whether this requires explicit user confirmation */
  requiresConfirmation?: boolean
  /** Example invocations */
  examples?: string[]
}

export const COMMAND_REGISTRY: CommandEntry[] = [
  // ── Project Commands ──
  {
    name: "test",
    aliases: ["tests", "run-tests"],
    category: "project",
    description: "Run the complete testing pipeline (vitest)",
    usage: "/test [path] [--watch]",
    examples: ["/test", "/test src/__tests__/foo.test.ts", "/test --watch"],
  },
  {
    name: "commit",
    aliases: ["git-commit", "push"],
    category: "project",
    description: "Create well-formatted commits with conventional messages",
    usage: "/commit [message]",
    examples: ["/commit", "/commit \"fix: resolve auth issue\""],
  },
  {
    name: "build",
    aliases: ["compile", "build-all"],
    category: "project",
    description: "Build project artifacts (Next.js, Solidity, CodeNomad)",
    usage: "/build [target]",
    examples: ["/build", "/build next", "/build solidity", "/build codenomad"],
  },
  {
    name: "deploy",
    aliases: ["publish", "release"],
    category: "project",
    description: "Deploy to Vercel, Solidity networks, or CodeNomad tunnel",
    usage: "/deploy [target]",
    examples: ["/deploy vercel", "/deploy solidity:sepolia", "/deploy codenomad"],
    requiresConfirmation: true,
  },
  {
    name: "clean",
    aliases: ["format", "prettier", "lint-fix"],
    category: "project",
    description: "Clean codebase via Prettier, ESLint, and TypeScript",
    usage: "/clean [path]",
  },
  {
    name: "optimize",
    aliases: ["perf", "performance"],
    category: "project",
    description: "Analyze code for performance, security, and potential issues",
  },
  {
    name: "analyze",
    aliases: ["analyze-patterns", "patterns"],
    category: "project",
    description: "Analyze codebase for patterns and similar implementations",
  },
  {
    name: "validate",
    aliases: ["check", "validate-repo"],
    category: "project",
    description: "Run comprehensive validation across all project gates",
    usage: "/validate [gate]",
    examples: ["/validate", "/validate ci", "/validate redux"],
  },

  // ── Agent Commands ──
  {
    name: "agent",
    aliases: ["agents", "list-agents", "who"],
    category: "agent",
    description: "List, inspect, or dispatch agents. @agent_name also works.",
    usage: "/agent [name] [directive]",
    examples: ["/agent", "/agent developer fix the login bug", "@developer fix the login bug"],
  },
  {
    name: "dispatch",
    aliases: ["spawn", "delegate", "assign"],
    category: "agent",
    description: "Dispatch a task to a specific agent with full context",
    usage: "/dispatch <agent> <task description>",
    examples: ["/dispatch developer implement SCR-007 phase 2"],
    requiresConfirmation: true,
  },
  {
    name: "status",
    aliases: ["progress", "whats-happening"],
    category: "agent",
    description: "Check current agent/task status, active sessions, queue",
    usage: "/status [agent|task-id]",
    examples: ["/status", "/status developer", "/status TASK-007"],
  },

  // ── Sidecar Commands ──
  {
    name: "sidecar",
    aliases: ["sidecars", "services"],
    category: "sidecar",
    description: "Manage sidecar servers (venue-staff, entry, bridge)",
    usage: "/sidecar <action> [name]",
    examples: ["/sidecar status", "/sidecar start venue-staff", "/sidecar restart entry"],
  },
  {
    name: "codenomad",
    aliases: ["cn", "tunnel", "server"],
    category: "sidecar",
    description: "Build, restart, and monitor the CodeNomad tunnel server",
    usage: "/codenomad <action>",
    examples: ["/codenomad status", "/codenomad build-restart"],
  },
  {
    name: "bridge",
    aliases: ["bridge-status", "validator"],
    category: "sidecar",
    description: "Cross-chain bridge validator operations (Sepolia ⇄ BSC)",
    usage: "/bridge <action>",
    examples: ["/bridge status", "/bridge start", "/bridge logs"],
  },

  // ── Solidity Commands ──
  {
    name: "solidity",
    aliases: ["sol", "contract"],
    category: "solidity",
    description: "Solidity contract compilation, testing, and deployment",
    usage: "/solidity <action> [contract]",
    examples: ["/solidity compile", "/solidity test", "/solidity deploy RevenuePool"],
  },
  {
    name: "verify",
    aliases: ["verify-contract", "etherscan"],
    category: "solidity",
    description: "Verify Solidity contracts on Etherscan/block explorer",
    usage: "/verify <contract> <address> [network]",
  },

  // ── Orchestration Commands ──
  {
    name: "workflow",
    aliases: ["wf", "flow", "pipeline"],
    category: "orchestration",
    description: "Define and execute multi-step workflows",
    usage: "/workflow <name> [steps...]",
    examples: ["/workflow deploy-all", "/workflow test-and-deploy"],
  },
  {
    name: "task",
    aliases: ["tasks", "todo"],
    category: "orchestration",
    description: "Create, list, or manage tasks",
    usage: "/task <action> [args]",
    examples: ["/task list", "/task create Implement login", "/task close TASK-007"],
  },
  {
    name: "scr",
    aliases: ["spec", "scrs", "spec-change"],
    category: "orchestration",
    description: "Create or review Spec Change Requests",
    usage: "/scr <action> [name]",
    examples: ["/scr new Add billing feature", "/scr list"],
  },
  {
    name: "discuss",
    aliases: ["discussion", "talk", "sync"],
    category: "orchestration",
    description: "Start a tracked discussion for workflow-relevant decisions",
    usage: "/discuss <topic>",
    examples: ["/discuss Architecture approach for phase 2"],
  },

  // ── Obsidian / Vault Commands ──
  {
    name: "opsx-new",
    aliases: ["openspec-new"],
    category: "obsidian",
    description: "Start a new OpenSpec change using artifact workflow",
    usage: "/opsx-new <change-name>",
  },
  {
    name: "opsx-continue",
    aliases: ["openspec-continue"],
    category: "obsidian",
    description: "Continue working on a change — create the next artifact",
    usage: "/opsx-continue",
  },
  {
    name: "opsx-apply",
    aliases: ["openspec-apply"],
    category: "obsidian",
    description: "Implement tasks from an OpenSpec change",
    usage: "/opsx-apply <change>",
  },
  {
    name: "opsx-verify",
    aliases: ["openspec-verify"],
    category: "obsidian",
    description: "Verify implementation matches change artifacts",
    usage: "/opsx-verify <change>",
  },
  {
    name: "opsx-archive",
    aliases: ["openspec-archive"],
    category: "obsidian",
    description: "Archive a completed change",
    usage: "/opsx-archive <change>",
  },
  {
    name: "opsx-explore",
    aliases: ["openspec-explore", "explore"],
    category: "obsidian",
    description: "Enter explore mode — think through ideas, investigate problems",
    usage: "/opsx-explore",
  },
  {
    name: "opsx-ff",
    aliases: ["openspec-ff", "fast-forward"],
    category: "obsidian",
    description: "Fast-forward through artifact creation",
    usage: "/opsx-ff <change>",
  },
  {
    name: "vault",
    aliases: ["obsidian", "wiki"],
    category: "obsidian",
    description: "Sync and validate the Obsidian architecture vault",
    usage: "/vault <action>",
    examples: ["/vault sync", "/vault validate", "/vault status"],
  },
  {
    name: "context",
    aliases: ["ctx", "knowledge"],
    category: "obsidian",
    description: "Context system manager — harvest, extract, organize knowledge",
    usage: "/context <action>",
  },
  {
    name: "add-context",
    aliases: ["learn", "remember"],
    category: "obsidian",
    description: "Add project patterns using Project Intelligence standard",
    usage: "/add-context <pattern>",
  },

  // ── Skill Commands ──
  {
    name: "skill",
    aliases: ["skills", "load-skill"],
    category: "skill",
    description: "Load a specialized skill by name",
    usage: "/skill <skill-name>",
    examples: ["/skill enforce-frontend-state", "/skill task-management"],
  },
  {
    name: "skills-list",
    aliases: ["list-skills", "available-skills"],
    category: "skill",
    description: "List all available skills",
  },

  // ── Tool Commands ──
  {
    name: "zenstack",
    aliases: ["zs", "zen", "orm"],
    category: "tool",
    description: "Regenerate ZenStack ORM artifacts from schema.zmodel",
    usage: "/zenstack <action>",
    examples: ["/zenstack generate", "/zenstack push", "/zenstack setup", "/zenstack studio"],
  },
  {
    name: "knowledge",
    aliases: ["kb", "digest", "cache-status"],
    category: "tool",
    description: "Check or refresh the shared knowledge cache",
    usage: "/knowledge <action>",
    examples: ["/knowledge status", "/knowledge refresh"],
  },
  {
    name: "help",
    aliases: ["?", "commands"],
    category: "tool",
    description: "Show available commands grouped by category",
    usage: "/help [category|command]",
    examples: ["/help", "/help agent", "/help deploy"],
  },
]

// ── Directive Syntax (Flow Definitions) ──────────────────────
//
// @mention and [A → B: directive] syntax for defining process flows.
//
// Examples:
//   "@developer fix the login bug then @qa verify it"
//   "[BA → Dev: implement SCR-007 phase 2] then [Dev → QA: verify]"
//   "investigate | implement | verify | deploy"
//   "@PMA dispatch developer:Fix login, qa:Test login"

export interface ProcessDirective {
  /** Source agent (undefined = user/current) */
  from?: string
  /** Target agent */
  to: string
  /** Action/verb */
  action: string
  /** Target/object of action */
  target?: string
  /** Extra parameters */
  params?: Record<string, string>
  /** Raw text of the directive */
  raw: string
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Find an agent by name or alias. Case-insensitive.
 */
export function findAgent(name: string): AgentEntry | undefined {
  const lower = name.toLowerCase().replace(/^@/, "")
  return AGENT_REGISTRY.find(
    (a) => a.name === lower || a.aliases.includes(lower),
  )
}

/**
 * Find a command by name or alias. Case-insensitive, with or without leading /
 */
export function findCommand(name: string): CommandEntry | undefined {
  const lower = name.toLowerCase().replace(/^\//, "")
  return COMMAND_REGISTRY.find(
    (c) => c.name === lower || c.aliases.includes(lower),
  )
}

/**
 * Get all commands grouped by category for help display.
 */
export function getCommandsByCategory(): Record<string, CommandEntry[]> {
  const grouped: Record<string, CommandEntry[]> = {}
  for (const cmd of COMMAND_REGISTRY) {
    if (!grouped[cmd.category]) grouped[cmd.category] = []
    grouped[cmd.category].push(cmd)
  }
  return grouped
}

/**
 * Get all agent names (for autocomplete, @mention suggestions).
 */
export function getAllAgentNames(): string[] {
  const names = new Set<string>()
  for (const agent of AGENT_REGISTRY) {
    names.add(agent.name)
    for (const alias of agent.aliases) names.add(alias)
  }
  return [...names]
}

/**
 * Resolve an agent name to its canonical name.
 */
export function resolveAgentName(name: string): string | undefined {
  const agent = findAgent(name)
  return agent?.name
}
