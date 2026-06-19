import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { rollbackToPreviousCommit } from "../orchestrator/rollback"
import { apiGet } from "../orchestrator/starguard-client"

// ── Knowledge Base ─────────────────────────────────────────────

/** Query the StarCARD architecture knowledge base via StarGuard.
 *  Searches entities by keyword, domain, or category. Returns a
 *  human-readable summary of matching entities, relations, and diagrams. */
export async function queryKnowledgeBase(
  query: string,
  domain?: string,
  category?: string,
): Promise<string> {
  const params: Record<string, string> = {}
  if (query?.trim()) params.search = query.trim()
  if (domain?.trim()) params.domain = domain.trim()
  if (category?.trim()) params.category = category.trim()
  params.limit = "10"

  try {
    const res = await apiGet("/api/architecture/entities", params)
    if (!res.ok) {
      return `Knowledge base unavailable (${res.status}). Try investigate_codebase instead.`
    }
    const data = await res.json()
    const entities = data.entities || data || []
    if (!Array.isArray(entities) || entities.length === 0) {
      return "No matching entities found in the architecture knowledge base."
    }

    return entities.map((e: any) => {
      const lines = [
        `• ${e.name || e.stableId || "(unnamed)"}`,
        e.stableId ? `  ID: ${e.stableId}` : undefined,
        e.domain ? `  Domain: ${e.domain}` : undefined,
        e.category ? `  Category: ${e.category}` : undefined,
        e.description ? `  ${e.description.slice(0, 200)}` : undefined,
      ].filter(Boolean).join("\n")
      return lines
    }).join("\n\n")
  } catch (err) {
    return `Knowledge base query failed: ${(err as Error).message}`
  }
}

/** Get a compact summary of key architecture entities for prompt enrichment.
 *  Returns a plain-text digest of the most important entities. */
export async function getArchitectureDigest(): Promise<string> {
  try {
    const res = await apiGet("/api/architecture/entities", { limit: "20" })
    if (!res.ok) return ""
    const data = await res.json()
    const entities = data.entities || data || []
    if (!Array.isArray(entities)) return ""

    const byDomain = new Map<string, string[]>()
    for (const e of entities) {
      const domain = e.domain || "GENERAL"
      if (!byDomain.has(domain)) byDomain.set(domain, [])
      byDomain.get(domain)!.push(e.name || e.stableId || "(unnamed)")
    }

    const parts: string[] = ["Key StarCARD ecosystem entities:"]
    for (const [domain, names] of byDomain) {
      parts.push(`  ${domain}: ${names.slice(0, 5).join(", ")}`)
    }
    return parts.join("\n")
  } catch {
    return ""
  }
}

// ── Helpers ───────────────────────────────────────────────────

export async function captureGitDiff(workspaceRoot: string): Promise<string> {
  try {
    return execSync("git diff --cached --stat 2>/dev/null || echo '(no changes)'", {
      cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024,
    })
  } catch { return "(could not capture diff)" }
}

export async function checkDeployStatus(
  workspaceRoot: string,
): Promise<string> {
  try {
    const output = execSync("vercel list deployments --project starguard --limit 1 --yes 2>&1 || vercel --scope tokenizin-projects list deployments --limit 1 2>&1", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    })
    const lines = output.trim().split("\n").filter(Boolean)
    const header = lines.find((l) => l.includes("vercel.app"))
    const state = lines.find((l) => l.includes("Ready") || l.includes("Building") || l.includes("Error") || l.includes("Canceled"))
    return [
      header ? `Latest: ${header}` : "",
      state ? `State: ${state.trim()}` : "",
      output.length > 0 ? `\n${output.split("\n").slice(-5).join("\n")}` : "",
    ].filter(Boolean).join("\n").trim() || "Could not fetch deploy status."
  } catch {
    return "Could not fetch deploy status."
  }
}

// ── Tool Functions ────────────────────────────────────────────

// Stop words to filter out when AI passes the full user message verbatim
const STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been',
  'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'need', 'want', 'like', 'just',
  'also', 'very', 'too', 'so', 'if', 'then', 'than', 'that', 'this', 'these',
  'those', 'it', 'its', 'my', 'your', 'our', 'we', 'he', 'she', 'they', 'me',
  'you', 'us', 'no', 'not', 'nor', 'about', 'into', 'over', 'after', 'before',
  'between', 'under', 'above', 'below', 'out', 'off', 'up', 'down', 'how',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'all', 'any', 'each',
  'every', 'both', 'few', 'more', 'most', 'some', 'such', 'only', 'own', 'same',
  'here', 'there', 'now', 'then', 'tell', 'show', 'find', 'look', 'read',
  'please', 'help', 'start', 'begin', 'first', 'next', 'last', 'finally',
  'step', 'through', 'across', 'along', 'around', 'back', 'because', 'been',
  'during', 'end', 'far', 'get', 'going', 'got', 'make', 'made', 'much',
  'must', 'never', 'once', 'other', 'quite', 'rather', 'really', 'still',
  'well', 'yet', 'investigate', 'search', 'examine', 'understand', 'explain',
  'describe', 'check', 'verify', 'confirm', 'ensure', 'guarantee', 'provide',
  'give', 'take', 'use', 'using', 'used', 'via', 'way', 'ways', 'thing',
  'things', 'something', 'anything', 'everything', 'nothing', 'does', 'done',
  'doing', 'going', 'gone', 'goes', 'came', 'come', 'coming', 'bring',
  'brings', 'brought', 'without', 'within', 'whether', 'while', 'whole',
  'though', 'think', 'thanks', 'thank', 'say', 'says', 'said', 'see', 'seen',
  'saw', 'know', 'known', 'knew', 'new', 'old', 'big', 'small', 'large',
  'long', 'short', 'high', 'low', 'good', 'bad', 'best', 'worst', 'better',
  'worse', 'every', 'each', 'either', 'neither', 'enough', 'else', 'ever',
  'always', 'usually', 'often', 'sometimes', 'rarely', 'seldom', 'already',
  'yet', 'just', 'about', 'almost', 'nearly', 'really', 'actually', 'pretty',
  'quite', 'rather', 'somewhat', 'total', 'completely', 'entirely',
  'absolutely', 'perfectly', 'fully', 'partially', 'partly', 'largely',
  'mainly', 'mostly', 'primarily', 'mainly', 'running', 'running',
  'walk', 'walking', 'walked', 'run', 'ran',
])

export async function investigateCodebase(
  query: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Searching the codebase..." }))

  // Extract meaningful keywords: keep capitalized words, identifiers, and short technical terms
  const words = query
    .replace(/[^\w\s-]/g, ' ')      // replace punctuation with space (keep hyphens)
    .split(/\s+/)                     // split on whitespace
    .filter(Boolean)                 // remove empty
    .filter((w) => w.length > 2)     // remove 1-2 char words
    .filter((w) => !STOP_WORDS.has(w.toLowerCase())) // remove stop words
    .filter((w) => !/^\d+$/.test(w)) // remove pure numbers

  // Prioritize capitalized / CamelCase / snake_case / hyphenated terms (identifiers)
  const identifiers = words.filter((w) => /[A-Z]/.test(w) || /[-_]/.test(w) || /^\w+\.\w+$/.test(w))
  const remaining = words.filter((w) => !identifiers.includes(w))

  // Take up to 10 keywords total, prioritizing identifiers
  const keywords = [...identifiers, ...remaining].slice(0, 10)
  if (keywords.length === 0) {
    return "What specific code would you like me to investigate? Try mentioning a filename, component name, or contract address."
  }

  try {
    const pattern = keywords.join("|")
    let results: string
    try {
      results = execSync(
        `rg -l -i --engine auto "${pattern}" --type-add 'web:*.{ts,tsx,js,jsx,css,json}' --type web --glob '!node_modules' --glob '!.next' --glob '!public/codenomad' -m 5 2>/dev/null || true`,
        { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      )
    } catch {
      results = ""
    }

    const fileList = results.trim().split("\n").filter(Boolean).slice(0, 20)
    if (fileList.length === 0) return `No files found matching: ${keywords.join(", ")}`

    const previews: string[] = []
    for (const file of fileList.slice(0, 3)) {
      try {
        const content = execSync(`head -30 "${file}"`, { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 })
        previews.push(`📄 ${file}:\n${content}`)
      } catch {
        previews.push(`📄 ${file}: (could not read)`)
      }
    }

    return [
      `Found ${fileList.length} files matching: ${keywords.join(", ")}`,
      "",
      ...fileList.map((f) => `- ${f}`),
      "",
      "--- Previews ---",
      "",
      ...previews,
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function generateFeature(
  prompt: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Generating feature..." }))

  const filesCreated: string[] = []

  try {
    if (/page|route/i.test(prompt)) {
      const match = prompt.match(/(\w+)\s*page/i) || prompt.match(/add\s+(?:a\s+)?(\w+)/i)
      const pageName = match ? match[1].toLowerCase() : "new-feature"
      const dir = path.join(workspaceRoot, "src", "app", pageName)
      fs.mkdirSync(dir, { recursive: true })

      const pageContent = [
        "'use client'",
        "",
        `export default function ${pageName.charAt(0).toUpperCase() + pageName.slice(1)}Page() {`,
        "  return (",
        `    <div className="p-8">`,
        `      <h1 className="text-2xl font-bold text-white">${pageName.charAt(0).toUpperCase() + pageName.slice(1)}</h1>`,
        `      <p className="text-gray-400 mt-2">Generated by TokiDAPP Concierge</p>`,
        "    </div>",
        "  )",
        "}",
        "",
      ].join("\n")

      fs.writeFileSync(path.join(dir, "page.tsx"), pageContent)
      filesCreated.push(`src/app/${pageName}/page.tsx`)
    }

    if (/component/i.test(prompt)) {
      const match = prompt.match(/(\w+)\s*component/i) || prompt.match(/component\s+(\w+)/i)
      const compName = match ? match[1] : "GeneratedComponent"
      const compPascal = compName.charAt(0).toUpperCase() + compName.slice(1)

      const componentContent = [
        "'use client'",
        "",
        `export function ${compPascal}({ className = "" }: { className?: string }) {`,
        "  return (",
        `    <div className={\`p-4 rounded-xl border border-white/10 bg-white/5 \${className}\`}>`,
        `      <p className="text-gray-400">${compPascal}</p>`,
        "    </div>",
        "  )",
        "}",
        "",
      ].join("\n")

      const compDir = path.join(workspaceRoot, "src", "components")
      fs.mkdirSync(compDir, { recursive: true })
      fs.writeFileSync(path.join(compDir, `${compPascal}.tsx`), componentContent)
      filesCreated.push(`src/components/${compPascal}.tsx`)
    }

    if (filesCreated.length === 0) {
      return "Please be more specific. Try: 'Add a metrics page' or 'Create a Dashboard component'"
    }

    return [
      `Created ${filesCreated.length} file(s):`,
      "",
      ...filesCreated.map((f) => `- ${f}`),
      "",
      "Run `bun run type-check` to verify.",
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function runTests(
  workspaceRoot: string,
  send?: (msg: string) => void,
  timeout?: number,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running tests..." }))

  try {
    const startTime = Date.now()
    let output: string
    try {
      output = execSync("bun run test 2>&1", {
        cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: timeout ?? 120000,
      })
    } catch (e: any) {
      output = e.stdout || e.message || "Test execution failed"
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const passMatch = output.match(/(\d+)\s+passed/i)
    const failMatch = output.match(/(\d+)\s+failed/i)
    const passed = passMatch ? passMatch[1] : "?"
    const failed = failMatch ? failMatch[1] : "0"

    return [
      `Tests completed in ${duration}s`,
      `Passed: ${passed} | Failed: ${failed}`,
      failed !== "0" ? "Some tests failed." : "All tests passing!",
      "",
      "--- Last 20 lines ---",
      output.split("\n").slice(-20).join("\n"),
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function gitStatus(workspaceRoot: string): Promise<string> {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    const status = execSync("git status --short", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    const log = execSync("git log --oneline -5", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    const filesChanged = status ? status.split("\n").length : 0

    return [
      `Branch: ${branch}`,
      `Uncommitted: ${filesChanged} file(s)`,
      status ? `\n${status}` : "\n   (clean)",
      "",
      "--- Recent commits ---",
      log,
    ].join("\n")
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

export async function gitCommitPush(
  commitMsg: string,
  workspaceRoot: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Committing changes..." }))

  try {
    const diff = await captureGitDiff(workspaceRoot)
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
    execSync("git add -A", { cwd: workspaceRoot, encoding: "utf-8" })
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: workspaceRoot, encoding: "utf-8" })

    if (send) send(JSON.stringify({ type: "stream", delta: "Pushing to remote..." }))
    execSync(`git push origin ${branch}`, { cwd: workspaceRoot, encoding: "utf-8", timeout: 30000 })

    const hash = execSync("git rev-parse HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()

    // Store diff as blob if starguardBase configured
    try {
      await fetch(`${starguardBase}/api/tokidapp/deploy-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "store_diff",
          commitHash: hash,
          commitMsg,
          diff,
          branch,
        }),
      })
    } catch { /* non-critical */ }

    return `Committed and pushed: ${hash.slice(0, 7)} on ${branch}\n\nFiles changed:\n${diff}`
  } catch (err) {
    return `Git error: ${(err as Error).message}`
  }
}

export async function triggerVercelDeploy(
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Triggering Vercel deploy..." }))

  try {
    const output = execSync("vercel deploy --prod --yes 2>&1", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 300000,
    })
    const urlMatch = output.match(/https:\/\/[^\s]+\.vercel\.app/)
    const url = urlMatch ? urlMatch[0] : "(see build output)"
    return `Deploy triggered. Preview: ${url}\n\nBuild output:\n${output.split("\n").slice(-10).join("\n")}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Deploy error: ${msg}`
  }
}

export async function spawnAgent(
  prompt: string,
  starguardBase: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Spawning agent workspace..." }))

  if (!starguardBase) return "StarGuard API not configured."

  // Parse agent type from prompt
  const agentType = prompt.includes("opencoder")
    ? "OPENCODER"
    : prompt.includes("openagent")
      ? "OPENAGENT"
      : prompt.includes("buildmate")
        ? "BUILDMATE"
        : "OPENCODE"

  const match = prompt.match(/in\s+([\w/-]+)/i)
  const workspacePath = match ? path.join(workspaceRoot, match[1]) : workspaceRoot

  try {
    const res = await fetch(`${starguardBase}/api/tokidapp/agents/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: `codenomad_${Date.now()}`,
        workspacePath,
        agentType,
        workspaceName: `Agent-${agentType}-${Date.now()}`,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return `Failed to spawn agent: ${err}`
    }

    const workspace = await res.json()
    return [
      `✅ **${agentType} agent spawned!**`,
      ``,
      `Workspace ID: \`${workspace.codenomadWorkspaceId || workspace.id}\``,
      workspace.codenomadProxyUrl ? `Proxy URL: ${workspace.codenomadProxyUrl}` : "",
      `Status: ${workspace.status}`,
      ``,
      `The agent is ready. Assign tasks to it using "assign task to <agent>".`,
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Error spawning agent: ${(err as Error).message}`
  }
}

export async function scheduleTask(
  prompt: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Creating scheduled task..." }))

  if (!starguardBase) return "StarGuard API not configured."

  // Parse task info from prompt
  const titleMatch = prompt.match(/(?:task|to)\s+[""]?([^""]+?)[""]?\s*(?:for|at|with|$)/i)
  const title = titleMatch ? titleMatch[1].trim() : prompt.replace(/schedule|create|add|task/gi, "").trim()
  const priorityMatch = prompt.match(/priority\s*[:\s]*(\d+)/i)
  const priority = priorityMatch ? parseInt(priorityMatch[1]) : 0

  // Parse scheduled time
  let scheduledFor: string | undefined
  const timeMatch = prompt.match(/(?:at|for)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/i) || prompt.match(/(?:at|for)\s+(\d{4}-\d{2}-\d{2})/i)
  if (timeMatch) scheduledFor = timeMatch[1]

  // Parse agent type
  const agentType = prompt.includes("opencoder")
    ? "OPENCODER" : prompt.includes("openagent")
      ? "OPENAGENT" : "OPENCODE"

  // Parse assignee
  const assignMatch = prompt.match(/(?:assign|to|for)\s+user\s+(\S+@\S+)/i)
  const assignedToUserId = assignMatch ? assignMatch[1] : undefined

  try {
    const body: Record<string, unknown> = {
      sessionId: `codenomad_${Date.now()}`,
      title,
      agentType,
      priority,
    }
    if (scheduledFor) body.scheduledFor = scheduledFor
    if (assignedToUserId) body.assignedToUserId = assignedToUserId

    const res = await fetch(`${starguardBase}/api/tokidapp/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      return `Failed to schedule task: ${err}`
    }

    const task = await res.json()
    return [
      `✅ **Task scheduled!**`,
      ``,
      `Title: ${task.title}`,
      `ID: \`${task.id}\``,
      `Agent: ${task.agentType}`,
      `Priority: ${task.priority}`,
      scheduledFor ? `Scheduled: ${scheduledFor}` : "Status: PENDING (no schedule set)",
      assignedToUserId ? `Assigned to: ${assignedToUserId}` : "",
      ``,
      `Use "list tasks" to see all scheduled tasks.`,
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Error scheduling task: ${(err as Error).message}`
  }
}

export async function listTasks(
  filter: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Fetching tasks..." }))

  if (!starguardBase) return "StarGuard API not configured."

  try {
    const params = new URLSearchParams()
    if (filter.includes("pending")) params.set("status", "PENDING")
    else if (filter.includes("assigned")) params.set("status", "ASSIGNED")
    else if (filter.includes("in progress")) params.set("status", "IN_PROGRESS")
    else if (filter.includes("complete")) params.set("status", "COMPLETED")

    const res = await fetch(`${starguardBase}/api/tokidapp/tasks?${params}`, {
      headers: { "Content-Type": "application/json" },
    })

    if (!res.ok) return "Could not fetch tasks."
    const tasks: any[] = await res.json()

    if (tasks.length === 0) return "No tasks found."

    return [
      `📋 **${tasks.length} task(s)**`,
      "",
      ...tasks.map((t, i) =>
        `**${i + 1}. ${t.title}**` +
        `\n   Status: ${t.status} | Agent: ${t.agentType} | Priority: ${t.priority}` +
        (t.assignedToUserId ? `\n   Assigned to: \`${t.assignedToUserId}\`` : "") +
        (t.scheduledFor ? `\n   Scheduled: ${new Date(t.scheduledFor).toISOString()}` : "") +
        (t.resultSummary ? `\n   Result: ${t.resultSummary}` : ""),
      ),
    ].join("\n")
  } catch (err) {
    return `Error listing tasks: ${(err as Error).message}`
  }
}

export async function assignTask(
  prompt: string,
  starguardBase: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Assigning task..." }))

  if (!starguardBase) return "StarGuard API not configured."

  // Parse task ID and assignee
  const taskIdMatch = prompt.match(/task\s+(\S+)/i)
  const userMatch = prompt.match(/(?:to|user)\s+(\S+@\S+|\S+)/i)

  if (!taskIdMatch) return "Please specify a task ID. Example: assign task abc123 to user@example.com"
  if (!userMatch) return "Please specify a user. Example: assign task abc123 to user@example.com"

  const taskId = taskIdMatch[1]
  const assignee = userMatch[1]

  try {
    const res = await fetch(`${starguardBase}/api/tokidapp/tasks/${taskId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedToUserId: assignee }),
    })

    if (!res.ok) {
      const err = await res.text()
      return `Failed to assign task: ${err}`
    }

    const task = await res.json()
    return [
      `✅ **Task assigned!**`,
      ``,
      `Task: ${task.title}`,
      `Assigned to: ${assignee}`,
      `Status: ${task.status}`,
    ].join("\n")
  } catch (err) {
    return `Error assigning task: ${(err as Error).message}`
  }
}

export async function rollbackDeploy(send?: (msg: string) => void): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Rolling back to previous commit..." }))

  const result = await rollbackToPreviousCommit(true)
  if (!result.success) {
    return `Rollback error: ${result.error}`
  }

  return [
    `⏪ **Rolled back to:** ${result.previousHash}`,
    `Previous commit: ${result.previousMsg}`,
    "",
    "Redeploy triggered.",
  ].join("\n")
}

// ── Accessibility Testing Tools ──────────────────────────────────

export async function runA11yAudit(
  url: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running accessibility audit..." }))

  try {
    const output = execSync(
      `npx lighthouse "${url}" --quiet --output=json --only-categories=accessibility --chrome-flags="--headless --no-sandbox" 2>/dev/null || true`,
      { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
    )

    // Parse the lighthouse JSON output
    const match = output.match(/\{[^]*\}/)
    if (!match) return "Could not parse lighthouse output. Try running from a directory with a package.json."
    
    const data = JSON.parse(match[0])
    const a11y = data?.categories?.accessibility
    if (!a11y) return "Accessibility audit did not return results."

    const score = Math.round((a11y.score ?? 0) * 100)
    const audits = data?.audits || {}
    const failedAudits: string[] = []

    for (const [key, audit] of Object.entries(audits) as [string, any][]) {
      if (audit.score !== null && audit.score < 1 && audit.score !== undefined) {
        failedAudits.push(`- ${audit.title}: ${audit.description?.split(".")[0] || "issue found"}`)
      }
    }

    return [
      `**Accessibility Score: ${score}/100**`,
      score >= 90 ? "✅ Great! Passes accessibility guidelines." :
      score >= 50 ? "⚠️ Needs improvement." :
      "❌ Significant accessibility issues found.",
      "",
      failedAudits.length > 0
        ? `Issues found (${failedAudits.length}):\n${failedAudits.slice(0, 15).join("\n")}${failedAudits.length > 15 ? `\n... and ${failedAudits.length - 15} more` : ""}`
        : "No critical issues detected.",
    ].join("\n")
  } catch (err) {
    return `Accessibility audit error: ${(err as Error).message}. Ensure lighthouse is available via npx.`
  }
}

export async function checkA11yScan(
  url: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Scanning for accessibility violations..." }))

  try {
    const output = execSync(
      `npx axe "${url}" --show-errors 2>/dev/null || true`,
      { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
    )

    // Parse axe JSON output (look for JSON block)
    const jsonMatch = output.match(/\{"violations":\[[\s\S]*?"inapplicable":\[[\s\S]*?\]\}/)
    if (!jsonMatch) return "Axe scan did not return results. Try: npx axe <url>"

    const data = JSON.parse(jsonMatch[0])
    const violations = data.violations || []
    const passes = data.passes || []
    const incomplete = data.incomplete || []

    if (violations.length === 0) {
      return [
        "✅ **No accessibility violations found!**",
        `Passed ${passes.length} checks.`,
        incomplete.length > 0 ? `${incomplete.length} items need manual review.` : "",
      ].filter(Boolean).join("\n")
    }

    const summary = violations.map((v: any) =>
      `- **${v.impact.toUpperCase()}**: ${v.help} (${v.nodes.length} nodes)\n  ${v.helpUrl || ""}`
    )

    return [
      `**${violations.length} violation(s) found**`,
      "",
      ...summary,
      "",
      `Passed: ${passes.length} | Incomplete: ${incomplete.length} | Violations: ${violations.length}`,
    ].join("\n")
  } catch (err) {
    return `Axe scan error: ${(err as Error).message}. Install with: npx axe`
  }
}

export async function checkColorContrast(
  filePath: string,
  workspaceRoot: string,
): Promise<string> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath)
  if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`

  try {
    const content = fs.readFileSync(fullPath, "utf-8")

    // Extract hex/rgb color pairs from common patterns
    const colorPatterns = [
      ...content.matchAll(/(?:color|background|background-color|border-color|outline-color)\s*:\s*([^;]+)/gi),
    ]

    const colors = new Set<string>()
    for (const [, value] of colorPatterns) {
      const hexMatch = value.match(/#([0-9a-fA-F]{3,8})\b/g)
      if (hexMatch) hexMatch.forEach((c) => colors.add(c))
      const rgbMatch = value.match(/rgb[a]?\([^)]+\)/g)
      if (rgbMatch) rgbMatch.forEach((c) => colors.add(c))
    }

    if (colors.size < 2) {
      return `Found ${colors.size} color(s) in ${path.basename(fullPath)}. Need at least 2 for contrast checking.\nColors: ${Array.from(colors).join(", ")}`
    }

    return [
      `**Color Contrast Check**: ${path.basename(fullPath)}`,
      `Found ${colors.size} color value(s).`,
      "",
      "For manual contrast check:",
      "- Use https://webaim.org/resources/contrastchecker/",
      "- Normal text (AA): 4.5:1 | Large text (AA): 3:1 | AAA: 7:1",
      "",
      `Detected colors:\n${Array.from(colors).map((c) => `  - ${c}`).join("\n")}`,
    ].join("\n")
  } catch (err) {
    return `Color contrast check error: ${(err as Error).message}`
  }
}

// ── Read File ────────────────────────────────────────────────────

export async function readFileContent(
  filePath: string,
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath)
  if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`
  
  try {
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(fullPath)
      return [
        `📁 **${filePath}/** (directory, ${entries.length} entries)`,
        "",
        ...entries.map((e) => {
          const isDir = fs.statSync(path.join(fullPath, e)).isDirectory()
          return `${isDir ? "📁" : "📄"} ${e}${isDir ? "/" : ""}`
        }),
      ].join("\n")
    }

    const content = fs.readFileSync(fullPath, "utf-8")
    const lines = content.split("\n")
    
    // Truncate very large files
    const maxLines = 200
    const truncated = lines.length > maxLines
    const display = truncated ? lines.slice(0, maxLines) : lines

    if (send) send(JSON.stringify({ type: "stream", delta: `Reading ${path.basename(fullPath)} (${display.length} of ${lines.length} lines)...` }))

    return [
      `📄 **${filePath}** (${lines.length} lines, ${(stat.size / 1024).toFixed(1)}KB)`,
      "",
      "```",
      ...display,
      truncated ? `... (${lines.length - maxLines} more lines. Use a more specific search to narrow down.)` : "",
      "```",
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`
  }
}

// ── Lint & TypeScript ────────────────────────────────────────────

export async function runLint(
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running linter..." }))

  try {
    let output: string
    try {
      output = execSync("bun run lint 2>&1 || true", {
        cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 60000,
      })
    } catch (e: any) {
      output = e.stdout || e.message || "Lint execution failed"
    }

    const lines = output.split("\n").filter(Boolean)
    const errorCount = lines.filter((l) => l.includes("error")).length
    const warningCount = lines.filter((l) => l.includes("warning")).length

    return [
      `**Lint Results**`,
      `Errors: ${errorCount} | Warnings: ${warningCount}`,
      errorCount + warningCount === 0 ? "✅ Clean!" : "",
      "",
      ...lines.slice(-30),
    ].filter(Boolean).join("\n")
  } catch (err) {
    return `Lint error: ${(err as Error).message}`
  }
}

export async function runTypeCheck(
  workspaceRoot: string,
  send?: (msg: string) => void,
): Promise<string> {
  if (send) send(JSON.stringify({ type: "stream", delta: "Running TypeScript type check..." }))

  try {
    const startTime = Date.now()
    let output: string
    
    // Try bun first, fall back to npx tsc
    try {
      output = execSync("bun run type-check 2>&1 || bunx tsc --noEmit 2>&1 || npx --yes tsc --noEmit 2>&1", {
        cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 120000,
      })
    } catch (e: any) {
      output = e.stdout || e.message || "Type check failed"
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const errorMatch = output.match(/Found\s+(\d+)\s+error/i) || output.match(/(\d+)\s+error/i)
    const errors = errorMatch ? parseInt(errorMatch[1]) : 0

    const clean = output.includes(" TS") === false || output.trim() === ""
    
    return [
      `**TypeScript Type Check** (${duration}s)`,
      errors > 0 ? `Found ${errors} type error(s).` : "✅ No type errors!",
      "",
      ...(errors > 0 ? output.split("\n").slice(-20) : []),
    ].join("\n")
  } catch (err) {
    return `Type check error: ${(err as Error).message}`
  }
}

// ── Git Branch ───────────────────────────────────────────────────

export async function gitBranchAction(
  action: string,
  branchName: string | undefined,
  workspaceRoot: string,
): Promise<string> {
  try {
    switch (action) {
      case "list": {
        const branches = execSync("git branch", { cwd: workspaceRoot, encoding: "utf-8" })
        const current = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim()
        return [
          `**Branches** (current: ${current})`,
          "",
          branches.split("\n").map((b) => b.trim()).filter(Boolean).map((b) =>
            b.startsWith("*") ? `* **${b.slice(2)}**` : `  ${b}`
          ).join("\n"),
        ].join("\n")
      }

      case "create": {
        if (!branchName) return "Branch name required for create action."
        execSync(`git checkout -b "${branchName}"`, { cwd: workspaceRoot, encoding: "utf-8" })
        return `✅ Created and switched to branch: \`${branchName}\``
      }

      case "switch": {
        if (!branchName) return "Branch name required for switch action."
        execSync(`git checkout "${branchName}"`, { cwd: workspaceRoot, encoding: "utf-8" })
        return `✅ Switched to branch: \`${branchName}\``
      }

      case "delete": {
        if (!branchName) return "Branch name required for delete action."
        execSync(`git branch -d "${branchName}"`, { cwd: workspaceRoot, encoding: "utf-8" })
        return `✅ Deleted branch: \`${branchName}\``
      }

      default:
        return `Unknown git branch action: ${action}. Supported: list, create, switch, delete`
    }
  } catch (err) {
    return `Git branch error: ${(err as Error).message}`
  }
}

// ── Vision (Image Analysis) ─────────────────────────────────────

/** Analyze an image using OpenAI gpt-4o vision. Accepts a direct URL
 *  (Vercel Blob URL or any public image URL). Returns a text description
 *  of what's in the image — usable by the concierge to answer questions
 *  about user-uploaded screenshots, diagrams, logos, etc. */
export async function visionAnalyze(imageUrl: string, prompt?: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return "Vision analysis requires OPENAI_API_KEY."

  const userPrompt = prompt?.trim()
    ? prompt
    : "Describe this image in detail. What do you see? Include colors, objects, text, layout, and any notable elements."

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
            ],
          },
        ],
        max_tokens: 1024,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      return `Vision API error (${res.status}): ${errBody.slice(0, 200)}`
    }

    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content || "(no description generated)"
    return content.slice(0, 4000)
  } catch (err) {
    return `Vision analysis failed: ${(err as Error).message}`
  }
}

// ── Mermaid Diagram Generation ───────────────────────────────────

/** Generate Mermaid diagram source code from a text description.
 *  Uses gpt-4o-mini to produce valid Mermaid syntax. The caller can
 *  render the returned source on the client using the Mermaid library.
 *  Returns the Mermaid code block (without markdown fences). */
export async function generateMermaidDiagram(
  description: string,
  diagramType?: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return "Mermaid generation requires OPENAI_API_KEY."

  const typeHint = diagramType?.trim()
    ? ` Use diagram type: ${diagramType}.`
    : " Choose the most appropriate diagram type (flowchart, sequence, class, state, gantt, pie, gitgraph, erDiagram, quadrantChart, timeline, etc.)."

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a Mermaid diagram expert. Generate valid Mermaid.js source code based on the user's description. " +
              "Follow these rules strictly:\n" +
              "1. Output ONLY the Mermaid source code — no explanations, no markdown fences (no ```), no extra text.\n" +
              "2. Use correct Mermaid syntax for the chosen diagram type.\n" +
              "3. Keep node labels short and meaningful.\n" +
              "4. For flowcharts, use graph TD or graph LR.\n" +
              "5. For sequence diagrams, use sequenceDiagram with proper participant/actor syntax.\n" +
              "6. For class diagrams, use classDiagram with proper class/relationship syntax.\n" +
              "7. Do NOT use any stylings that require Mermaid configuration directives unless essential.\n" +
              "8. If the description is ambiguous, choose the best diagram type and make reasonable assumptions.",
          },
          {
            role: "user",
            content: `Generate a Mermaid diagram for: ${description}.${typeHint}`,
          },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      return `Mermaid generation error (${res.status}): ${errBody.slice(0, 200)}`
    }

    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content || ""
    // Strip any markdown fences the model might add despite instructions
    const cleaned = content.replace(/^```(?:mermaid)?\s*\n?/gm, "").replace(/```\s*$/gm, "").trim()
    if (!cleaned) return "(no diagram generated)"
    return cleaned
  } catch (err) {
    return `Mermaid generation failed: ${(err as Error).message}`
  }
}

// ── Sepolia Deployments ──────────────────────────────────────────

/** Return known Sepolia testnet contract addresses for the StarCARD ecosystem. */
export async function getSepoliaDeployments(): Promise<string> {
  try {
    const filePath = path.join(__dirname, "../../../../../src/data/sepolia-deployments.ts")
    const absPath = path.resolve(filePath)
    if (!fs.existsSync(absPath)) {
      return "Sepolia deployments file not found."
    }
    const content = fs.readFileSync(absPath, "utf-8")
    // Extract just the deployment map
    const mapMatch = content.match(/(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*({[\s\S]*?})\s*(?:as\s+const)?\s*;?/m)
    if (mapMatch) {
      return `Sepolia deployments:\n\n\`\`\`\n${mapMatch[1].slice(0, 2000)}\n\`\`\``
    }
    return `Sepolia deployments file found but could not parse.\n\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``
  } catch (err) {
    return `Error reading deployments: ${(err as Error).message}`
  }
}
