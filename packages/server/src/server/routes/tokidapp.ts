import { execSync } from "child_process"
import { WebSocket, WebSocketServer } from "ws"
import * as fs from "fs"
import * as path from "path"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { StarGuardJwtHandler } from "../../auth/starguard-jwt"
import {
  createRealtimeSession,
  sendAudioChunk,
  commitAudioBuffer,
  resetInputAudio,
  hasEnoughInputAudio,
  clearAudioBuffer,
  endVoiceSession,
  getRealtimeSession,
  getRealtimeSessionVoice,
} from "../../plugins/tokidapp/concierge/openai-realtime"
import { normalizeRealtimeVoice } from "../../plugins/tokidapp/concierge/realtime-voices"
import { executeDAG, buildLifecycleDAG } from "../../plugins/tokidapp/orchestrator/dag-engine"
import {
  createApprovalRequest,
  waitForApprovalDecision,
  resolveApproval,
  submitApprovalDecision,
  fetchPendingApprovals,
  getPendingApprovals,
} from "../../plugins/tokidapp/orchestrator/approval-queue"
import { rollbackToPreviousCommit } from "../../plugins/tokidapp/orchestrator/rollback"
import { apiPost, apiGet, apiPut } from "../../plugins/tokidapp/orchestrator/starguard-client"
import type { DAGNode, DAGDefinition, ExecutionCallbacks } from "../../plugins/tokidapp/orchestrator/types"

const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const REALTIME_ENABLED = !!process.env.OPENAI_API_KEY
const VERCEL_DEPLOY_HOOK_URL = process.env.VERCEL_DEPLOY_HOOK_URL
const VERCEL_TOKEN = process.env.VERCEL_TOKEN
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://starguard.vercel.app"

// Cache for workflow definitions fetched from StarGuard
let workflowDefinitionsCache: any = null
let workflowCacheTime = 0
const WORKFLOW_CACHE_TTL = 300_000 // 5 minutes

interface TokiDAPPWebSocket {
  send: (msg: string) => void
  close: (code?: number, reason?: string) => void
}

const activeSockets = new Map<string, TokiDAPPWebSocket>()
const tokidappWss = new WebSocketServer({ noServer: true })

// ── CodeNomad Voice Realtime WebSocket ─────────────────────

const voiceWss = new WebSocketServer({ noServer: true })

interface VoiceRealtimeSocket {
  send: (msg: string) => void
  close: (code?: number, reason?: string) => void
}

function startVoiceRealtimeSession(
  sessionId: string,
  requestedVoice: unknown,
  socketRef: { send: (msg: string) => void },
) {
  const voice = normalizeRealtimeVoice(requestedVoice)
  const existingVoice = getRealtimeSessionVoice(sessionId)
  if (existingVoice && existingVoice !== voice) {
    endVoiceSession(sessionId)
  }
  resetInputAudio(sessionId)
  const notifyReady = () => {
    socketRef.send(JSON.stringify({ type: "voice_ready", voice }))
  }
  if (!getRealtimeSession(sessionId)) {
    createRealtimeSession(
      sessionId,
      (audioBase64) => socketRef.send(JSON.stringify({ type: "audio", data: audioBase64 })),
      (textDelta) => socketRef.send(JSON.stringify({ type: "stream", delta: textDelta })),
      (error) => socketRef.send(JSON.stringify({ type: "error", content: error })),
      notifyReady,
      (transcript) =>
        socketRef.send(JSON.stringify({ type: "user_transcript", content: transcript })),
      undefined,
      voice,
    )
  } else {
    notifyReady()
  }
}

const voiceSockets = new Map<string, VoiceRealtimeSocket>()

function attachVoiceSocket(ws: WebSocket, userId: string) {
  const sessionId = `voice_${userId}`
  const socketRef: VoiceRealtimeSocket = {
    send: (msg: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    },
    close: (code?: number, reason?: string) => {
      ws.close(code, reason)
    },
  }

  voiceSockets.set(sessionId, socketRef)

  socketRef.send(JSON.stringify({
    type: "voice_ready",
    sessionId,
  }))

  const cleanup = () => {
    voiceSockets.delete(sessionId)
    clearAudioBuffer(sessionId)
    endVoiceSession(sessionId)
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const raw = typeof data === "string" ? data : data.toString("utf8")
    const trimmed = raw.trim()
    if (!trimmed) return

    try {
      const msg = JSON.parse(trimmed)

      if (msg.type === "ping") {
        socketRef.send(JSON.stringify({ type: "pong" }))
        return
      }

      if (msg.type === "cancel") {
        socketRef.send(JSON.stringify({ type: "message", content: "Cancelled." }))
        return
      }

      if (msg.type === "voice_start") {
        if (REALTIME_ENABLED) {
          startVoiceRealtimeSession(sessionId, msg.voice, socketRef)
        } else {
          socketRef.send(JSON.stringify({ type: "message", content: "Voice mode requires OPENAI_API_KEY." }))
        }
        return
      }

      if (msg.type === "voice_stop") {
        if (hasEnoughInputAudio(sessionId)) {
          commitAudioBuffer(sessionId)
        } else {
          resetInputAudio(sessionId)
          socketRef.send(JSON.stringify({
            type: "voice_cancelled",
            content: "No speech detected. Hold the microphone a little longer.",
          }))
        }
        return
      }

      if (msg.type === "audio" && msg.data) {
        sendAudioChunk(sessionId, msg.data)
        return
      }
    } catch {
      // Ignore malformed JSON
    }
  })

  ws.on("close", cleanup)
  ws.on("error", cleanup)
}

export function registerVoiceRealtimeWebSocket(
  app: FastifyInstance,
  starGuardJwtHandler?: StarGuardJwtHandler,
) {
  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
    let parsed: URL
    try {
      parsed = new URL(rawUrl, "http://localhost")
    } catch {
      return
    }

    if (!parsed.pathname.startsWith("/api/voice/session")) return

    const token = parsed.searchParams.get("token") || ""
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    if (starGuardJwtHandler) {
      starGuardJwtHandler.verify(token).then((payload) => {
        if (!payload) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
          socket.destroy()
          return
        }
        voiceWss.handleUpgrade(request, socket, head, (ws) => {
          attachVoiceSocket(ws, payload.userId)
        })
      }).catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
        socket.destroy()
      })
      return
    }

    // No JWT handler — allow in dev mode
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      attachVoiceSocket(ws, token)
    })
  })
}

// ── Tool Implementations ─────────────────────────────────────

async function investigateCodebase(query: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Searching the codebase..." }))

  const keywords = query.replace(/investigate|find|search|look|show|read|examine/gi, "").trim().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return "What would you like me to investigate?"

  try {
    const pattern = keywords.join("|")
    let results: string
    try {
      results = execSync(
        `rg -l -i "${pattern}" --type ts --type tsx --type css --glob '!node_modules' --glob '!.next' --glob '!public/codenomad' 2>/dev/null | head -20`,
        { cwd: WORKSPACE_ROOT, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      )
    } catch {
      results = ""
    }

    const fileList = results.trim().split("\n").filter(Boolean)
    if (fileList.length === 0) return `No files found matching: ${keywords.join(", ")}`

    const previews: string[] = []
    for (const file of fileList.slice(0, 3)) {
      try {
        const content = execSync(`head -30 "${file}"`, { cwd: WORKSPACE_ROOT, encoding: "utf-8", maxBuffer: 1024 * 1024 })
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

async function generateFeature(prompt: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Generating feature..." }))

  const filesCreated: string[] = []

  try {
    if (/page|route/i.test(prompt)) {
      const match = prompt.match(/(\w+)\s*page/i) || prompt.match(/add\s+(?:a\s+)?(\w+)/i)
      const pageName = match ? match[1].toLowerCase() : "new-feature"
      const dir = path.join(WORKSPACE_ROOT, "src", "app", pageName)
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

      const compDir = path.join(WORKSPACE_ROOT, "src", "components")
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

async function runTests(send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Running tests..." }))

  try {
    const startTime = Date.now()
    let output: string
    try {
      output = execSync("bun run test 2>&1", { cwd: WORKSPACE_ROOT, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 120000 })
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

async function gitStatus(): Promise<string> {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()
    const status = execSync("git status --short", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()
    const log = execSync("git log --oneline -5", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()
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

async function captureGitDiff(): Promise<string> {
  try {
    return execSync("git diff --cached --stat 2>/dev/null || echo '(no changes)'", {
      cwd: WORKSPACE_ROOT, encoding: "utf-8", maxBuffer: 1024 * 1024,
    })
  } catch { return "(could not capture diff)" }
}

async function gitCommitPush(commitMsg: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Committing changes..." }))

  try {
    const diff = captureGitDiff()
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()
    execSync("git add -A", { cwd: WORKSPACE_ROOT, encoding: "utf-8" })
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: WORKSPACE_ROOT, encoding: "utf-8" })

    send(JSON.stringify({ type: "stream", delta: "Pushing to remote..." }))
    execSync(`git push origin ${branch}`, { cwd: WORKSPACE_ROOT, encoding: "utf-8", timeout: 30000 })

    const hash = execSync("git rev-parse HEAD", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()

    // Store diff as blob if STARGUARD_BASE configured
    try {
      await fetch(`${STARGUARD_BASE}/api/tokidapp/deploy-status`, {
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

async function rollbackDeploy(send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Rolling back to previous commit..." }))

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

async function triggerVercelDeploy(send: (msg: string) => void): Promise<string> {
  if (!VERCEL_DEPLOY_HOOK_URL) {
    return "VERCEL_DEPLOY_HOOK_URL not configured. Set it in the environment."
  }

  send(JSON.stringify({ type: "stream", delta: "Triggering Vercel deploy..." }))

  try {
    const res = await fetch(VERCEL_DEPLOY_HOOK_URL, { method: "POST" })
    if (!res.ok) {
      const err = await res.text()
      return `Deploy hook failed: ${res.status} ${err}`
    }
    return "Deploy triggered on Vercel. Building..."
  } catch (err) {
    return `Deploy error: ${(err as Error).message}`
  }
}

async function checkDeployStatus(): Promise<string> {
  if (!VERCEL_TOKEN) return "VERCEL_TOKEN not configured."

  try {
    const params = new URLSearchParams({ limit: "1" })
    if (VERCEL_PROJECT_ID) params.set("projectId", VERCEL_PROJECT_ID)
    if (VERCEL_TEAM_ID) params.set("teamId", VERCEL_TEAM_ID)

    const res = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    })

    if (!res.ok) return "Could not fetch deploy status."
    const data: any = await res.json()
    const deploy = data.deployments?.[0]
    if (!deploy) return "No deployments found."

    return [
      `Latest deploy: ${deploy.name}`,
      `URL: https://${deploy.url}`,
      `State: ${deploy.readyState}`,
      `Created: ${new Date(deploy.createdAt).toISOString()}`,
    ].join("\n")
  } catch {
    return "Could not fetch deploy status."
  }
}

// ── Agent Spawning ────────────────────────────────────────────

async function spawnAgent(prompt: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Spawning agent workspace..." }))

  if (!STARGUARD_BASE) return "StarGuard API not configured."

  // Parse agent type from prompt
  const agentType = prompt.includes("opencoder")
    ? "OPENCODER"
    : prompt.includes("openagent")
      ? "OPENAGENT"
      : prompt.includes("buildmate")
        ? "BUILDMATE"
        : "OPENCODE"

  const match = prompt.match(/in\s+([\w/-]+)/i)
  const workspacePath = match ? path.join(WORKSPACE_ROOT, match[1]) : WORKSPACE_ROOT

  try {
    const res = await fetch(`${STARGUARD_BASE}/api/tokidapp/agents/spawn`, {
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

// ── Task Scheduling ───────────────────────────────────────────

async function scheduleTask(prompt: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Creating scheduled task..." }))

  if (!STARGUARD_BASE) return "StarGuard API not configured."

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

    const res = await fetch(`${STARGUARD_BASE}/api/tokidapp/tasks`, {
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

async function listTasks(filter: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Fetching tasks..." }))

  if (!STARGUARD_BASE) return "StarGuard API not configured."

  try {
    const params = new URLSearchParams()
    if (filter.includes("pending")) params.set("status", "PENDING")
    else if (filter.includes("assigned")) params.set("status", "ASSIGNED")
    else if (filter.includes("in progress")) params.set("status", "IN_PROGRESS")
    else if (filter.includes("complete")) params.set("status", "COMPLETED")

    const res = await fetch(`${STARGUARD_BASE}/api/tokidapp/tasks?${params}`, {
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

async function assignTask(prompt: string, send: (msg: string) => void): Promise<string> {
  send(JSON.stringify({ type: "stream", delta: "Assigning task..." }))

  if (!STARGUARD_BASE) return "StarGuard API not configured."

  // Parse task ID and assignee
  const taskIdMatch = prompt.match(/task\s+(\S+)/i)
  const userMatch = prompt.match(/(?:to|user)\s+(\S+@\S+|\S+)/i)

  if (!taskIdMatch) return "Please specify a task ID. Example: assign task abc123 to user@example.com"
  if (!userMatch) return "Please specify a user. Example: assign task abc123 to user@example.com"

  const taskId = taskIdMatch[1]
  const assignee = userMatch[1]

  try {
    const res = await fetch(`${STARGUARD_BASE}/api/tokidapp/tasks/${taskId}/assign`, {
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

// ── Message Router ────────────────────────────────────────────

async function routeMessage(
  content: string,
  send: (msg: string) => void,
  workflowSlug?: string,
  workflowStep?: number,
): Promise<void> {
  // If workflow context is provided, route by workflow slug
  if (workflowSlug && workflowStep) {
    const slugToHint: Record<string, string> = {
      "investigate-code": "investigate",
      "generate-feature": "generate",
      "run-tests": "test",
      "deploy-app": "deploy",
      "spawn-agent": "spawn agent",
      "schedule-task": "schedule task",
      "assign-task": "assign task",
    }
    const hint = slugToHint[workflowSlug]
    if (hint) {
      content = hint + " " + content
    }
  }
  const lower = content.toLowerCase()

  if (lower.includes("investigate") || lower.includes("find") || lower.includes("search") || lower.includes("look")) {
    send(JSON.stringify({ type: "tool_call", id: "1", tool: "investigate_codebase", status: "running", summary: "Searching codebase..." }))
    const result = await investigateCodebase(content, send)
    send(JSON.stringify({ type: "tool_result", id: "1", tool: "investigate_codebase", status: "complete", summary: result }))
  } else if (lower.includes("generate") || lower.includes("create") || lower.includes("add") || lower.includes("make")) {
    send(JSON.stringify({ type: "tool_call", id: "2", tool: "generate_feature", status: "running", summary: "Generating feature..." }))
    const result = await generateFeature(content, send)
    send(JSON.stringify({ type: "tool_result", id: "2", tool: "generate_feature", status: "complete", summary: result }))
  } else if (lower.includes("test") || lower.includes("verify") || lower.includes("check")) {
    send(JSON.stringify({ type: "tool_call", id: "3", tool: "run_tests", status: "running", summary: "Running tests..." }))
    const result = await runTests(send)
    send(JSON.stringify({ type: "tool_result", id: "3", tool: "run_tests", status: "complete", summary: result }))
  } else if (lower.includes("git status") || lower.includes("branch") || lower.includes("repo")) {
    send(JSON.stringify({ type: "tool_call", id: "4", tool: "git_status", status: "running", summary: "Checking git state..." }))
    const result = await gitStatus()
    send(JSON.stringify({ type: "tool_result", id: "4", tool: "git_status", status: "complete", summary: result }))
  } else if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish")) {
    send(JSON.stringify({ type: "tool_call", id: "5", tool: "git_commit_push", status: "running", summary: "Committing and pushing..." }))
    const gitResult = await gitCommitPush(content, send)
    send(JSON.stringify({ type: "tool_result", id: "5", tool: "git_commit_push", status: "complete", summary: gitResult }))

    send(JSON.stringify({ type: "tool_call", id: "6", tool: "trigger_deploy", status: "running", summary: "Triggering Vercel deploy..." }))
    const deployResult = await triggerVercelDeploy(send)
    send(JSON.stringify({ type: "tool_result", id: "6", tool: "trigger_deploy", status: "complete", summary: deployResult }))
  } else if (lower.includes("spawn") || lower.includes("start agent") || lower.includes("launch agent")) {
    send(JSON.stringify({ type: "tool_call", id: "7", tool: "spawn_agent", status: "running", summary: "Spawning agent..." }))
    const result = await spawnAgent(content, send)
    send(JSON.stringify({ type: "tool_result", id: "7", tool: "spawn_agent", status: "complete", summary: result }))
  } else if (lower.includes("schedule") || lower.includes("create task") || (lower.includes("add task") && !lower.includes("add a page"))) {
    send(JSON.stringify({ type: "tool_call", id: "8", tool: "schedule_task", status: "running", summary: "Scheduling task..." }))
    const result = await scheduleTask(content, send)
    send(JSON.stringify({ type: "tool_result", id: "8", tool: "schedule_task", status: "complete", summary: result }))
  } else if (lower.includes("list task") || lower.includes("show task") || lower.includes("my tasks") || lower.includes("all tasks")) {
    send(JSON.stringify({ type: "tool_call", id: "9", tool: "list_tasks", status: "running", summary: "Fetching tasks..." }))
    const result = await listTasks(content, send)
    send(JSON.stringify({ type: "tool_result", id: "9", tool: "list_tasks", status: "complete", summary: result }))
  } else if (lower.includes("assign task") || lower.includes("assign to")) {
    send(JSON.stringify({ type: "tool_call", id: "10", tool: "assign_task", status: "running", summary: "Assigning task..." }))
    const result = await assignTask(content, send)
    send(JSON.stringify({ type: "tool_result", id: "10", tool: "assign_task", status: "complete", summary: result }))
  } else if (lower.includes("rollback") || lower.includes("undo deploy") || lower.includes("revert")) {
    send(JSON.stringify({ type: "tool_call", id: "11", tool: "rollback_deploy", status: "running", summary: "Rolling back deploy..." }))
    const result = await rollbackDeploy(send)
    send(JSON.stringify({ type: "tool_result", id: "11", tool: "rollback_deploy", status: "complete", summary: result }))
  } else {
    send(JSON.stringify({
      type: "message",
      content: `I can help with:
• **Investigate** — search and read codebase files
• **Generate** — create new pages, components, routes
• **Test** — run the test suite
• **Git status** — check branch, changes, history
• **Deploy** — commit, push, and deploy to Vercel
• **Spawn agent** — launch OpenCode/OpenCoder/OpenAgent workspaces
• **Schedule task** — create and schedule tasks for agents or users
• **List tasks** — view all pending/assigned/completed tasks
• **Assign task** — assign a task to a specific user
• **Rollback deploy** — revert to the previous commit and redeploy

What would you like to do?`,
    }))
  }
}

// ── Workflow Definitions (fetched from StarGuard) ──────────────

async function fetchWorkflowDefinitions(): Promise<any[]> {
  try {
    const res = await fetch(`${STARGUARD_BASE}/api/tokidapp/workflows`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const data: any = await res.json()
    return data.workflows || []
  } catch {
    return []
  }
}

async function getWorkflowDefinitions(): Promise<any[]> {
  const now = Date.now()
  if (!workflowDefinitionsCache || now - workflowCacheTime > WORKFLOW_CACHE_TTL) {
    workflowDefinitionsCache = await fetchWorkflowDefinitions()
    workflowCacheTime = now
  }
  return workflowDefinitionsCache
}

// ── Routes ────────────────────────────────────────────────────

export function registerTokidappRoutes(app: FastifyInstance) {
  // Proxy: serve workflow definitions from StarGuard with local cache
  app.get("/api/tokidapp/workflows", async () => {
    const workflows = await getWorkflowDefinitions()
    return { version: 1, updatedAt: new Date().toISOString().split("T")[0], workflows, digitalAssets: [] }
  })

  // Health / status
  app.get("/api/tokidapp/status", async () => ({
    status: "ok",
    activeSockets: activeSockets.size,
    workspaceRoot: WORKSPACE_ROOT,
    vercelHookConfigured: !!VERCEL_DEPLOY_HOOK_URL,
  }))

  // Deploy shortcut (HTTP POST, no WebSocket needed)
  const DeployBodySchema = z.object({
    commitMsg: z.string().min(1),
  })

  app.post("/api/tokidapp/deploy", async (request, reply) => {
    try {
      const body = DeployBodySchema.parse(request.body ?? {})
      const send = (msg: string) => {} // no-op for HTTP path
      const gitResult = await gitCommitPush(body.commitMsg, send)
      const deployResult = await triggerVercelDeploy(send)
      return { git: gitResult, deploy: deployResult }
    } catch (error) {
      request.log.error({ err: error }, "TokiDAPP deploy failed")
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  // WS session info
  const SessionQuerySchema = z.object({
    token: z.string().min(1),
  })

  app.get("/api/tokidapp/ws/info", async (request, reply) => {
    try {
      const query = SessionQuerySchema.parse(request.query)
      return { sessionId: `tokidapp_${query.token}`, active: activeSockets.has(`tokidapp_${query.token}`) }
    } catch {
      reply.code(400)
      return { error: "token required" }
    }
  })

  // ── Orchestrator Routes ────────────────────────────────────

  app.post("/api/tokidapp/orchestrator", async (request, reply) => {
    try {
      const { sessionId, voiceMode = true } = (request.body || {}) as Record<string, unknown>

      const res = await apiPost("/api/tokidapp/orchestrator", { sessionId, voiceMode })

      if (!res.ok) {
        reply.code(res.status)
        return { error: "Failed to create orchestrator session" }
      }

      const orchestrator = await res.json()
      return orchestrator
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  app.get("/api/tokidapp/orchestrator/:id", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const res = await apiGet(`/api/tokidapp/orchestrator/${id}`)
      if (!res.ok) {
        reply.code(res.status)
        return { error: "Not found" }
      }
      return await res.json()
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  // ── Approval Routes ────────────────────────────────────────

  app.get("/api/tokidapp/approvals", async (request, reply) => {
    try {
      const query = request.query as Record<string, string>
      const params = new URLSearchParams()
      if (query.status) params.set("status", query.status)
      if (query.orchestratorId) params.set("orchestratorId", query.orchestratorId)
      if (query.assignedTo) params.set("assignedTo", query.assignedTo)

      const res = await apiGet("/api/tokidapp/approvals", Object.fromEntries(params))
      if (!res.ok) return []
      return await res.json()
    } catch {
      reply.code(500)
      return { error: "Failed to fetch approvals" }
    }
  })

  app.post("/api/tokidapp/approvals/:id/approve", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const { comment } = (request.body || {}) as Record<string, string>
      const success = await submitApprovalDecision(id, "approve", comment)
      if (!success) {
        reply.code(409)
        return { error: "Could not approve" }
      }
      return { approved: id }
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })

  app.post("/api/tokidapp/approvals/:id/reject", async (request, reply) => {
    try {
      const { id } = request.params as Record<string, string>
      const { comment } = (request.body || {}) as Record<string, string>
      const success = await submitApprovalDecision(id, "reject", comment)
      if (!success) {
        reply.code(409)
        return { error: "Could not reject" }
      }
      return { rejected: id }
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message }
    }
  })
}

// ── WebSocket Upgrade Handler ────────────────────────────────

export function registerTokidappWebSocket(app: FastifyInstance) {
  app.server.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/"
    let parsed: URL
    try {
      parsed = new URL(rawUrl, "http://localhost")
    } catch {
      return
    }

    if (!parsed.pathname.startsWith("/api/tokidapp/ws")) return

    const token = parsed.searchParams.get("token") || ""
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    tokidappWss.handleUpgrade(request, socket, head, (ws) => {
      attachTokidappSocket(ws, token)
    })
  })
}

function attachTokidappSocket(ws: WebSocket, token: string) {
  const sessionId = `tokidapp_${token}`
  const socketRef: TokiDAPPWebSocket = {
    send: (msg: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    },
    close: (code?: number, reason?: string) => {
      ws.close(code, reason)
    },
  }

  activeSockets.set(sessionId, socketRef)

  socketRef.send(JSON.stringify({
    type: "orchestrator_greeting",
    sessionId,
    voiceMode: REALTIME_ENABLED,
    content: "TokiDAPP Orchestrator connected. I can investigate code, generate features, run tests, orchestrate workflows with parallel execution, request approvals, and deploy to Vercel. Try saying: 'Analyze the current state and plan the next steps'.",
  }))

  if (REALTIME_ENABLED) {
    const greetingText = "Hello, I am your StarCARD orchestrator. I can help you investigate, build, test, deploy, and manage your entire workflow. What would you like to do?"
    socketRef.send(JSON.stringify({
      type: "stream",
      delta: greetingText,
    }))
  }

  const orchestratorSessions = new Map<string, string>()

  const cleanup = () => {
    activeSockets.delete(sessionId)
    orchestratorSessions.delete(sessionId)
    clearAudioBuffer(sessionId)
    endVoiceSession(sessionId)
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const raw = typeof data === "string" ? data : data.toString("utf8")
    const trimmed = raw.trim()
    if (!trimmed) return

    try {
      const msg = JSON.parse(trimmed)

          if (msg.type === "ping") {
            socketRef.send(JSON.stringify({ type: "pong" }))
            return
          }

          if (msg.type === "cancel") {
            socketRef.send(JSON.stringify({ type: "message", content: "Cancelled." }))
            return
          }

          if (msg.type === "voice_start") {
            if (REALTIME_ENABLED) {
              startVoiceRealtimeSession(sessionId, msg.voice, socketRef)
            } else {
              socketRef.send(JSON.stringify({ type: "message", content: "Voice mode requires OPENAI_API_KEY." }))
            }
            return
          }

          if (msg.type === "voice_stop") {
            if (hasEnoughInputAudio(sessionId)) {
              commitAudioBuffer(sessionId)
            } else {
              resetInputAudio(sessionId)
              socketRef.send(JSON.stringify({
                type: "voice_cancelled",
                content: "No speech detected. Hold the microphone a little longer.",
              }))
            }
            return
          }

          if (msg.type === "audio" && msg.data) {
            sendAudioChunk(sessionId, msg.data)
            return
          }

          if (msg.type === "orchestrate" && msg.intent) {
            // Start orchestrator session + DAG execution
            ;(async () => {
              const intent = msg.intent as string
              const context = (msg.context as Record<string, unknown>) || {}

              // Create orchestrator session via StarGuard
              try {
                const orchRes = await apiPost("/api/tokidapp/orchestrator", { sessionId, voiceMode: REALTIME_ENABLED })

                if (!orchRes.ok) {
                  socketRef.send(JSON.stringify({ type: "error", content: "Failed to create orchestrator session" }))
                  return
                }

                const orchestrator = await orchRes.json()
                const orchestratorId = orchestrator.id
                orchestratorSessions.set(sessionId, orchestratorId)

                socketRef.send(JSON.stringify({ type: "orchestrator_state", orchestratorId, status: "created", voiceMode: REALTIME_ENABLED }))

                // Build DAG from intent
                const { nodes, phases } = buildLifecycleDAG(
                  (context.intentType as string) || "QUERY_INFO",
                  intent,
                  (context.entities as Record<string, string>) || {},
                )

                const dag: DAGDefinition = {
                  id: `dag_${Date.now()}`,
                  nodes,
                  createdAt: new Date().toISOString(),
                }

                socketRef.send(JSON.stringify({
                  type: "message",
                  content: `Analyzing: ${phases.join(" → ")}`,
                }))

                // Notify each node as it starts
                const callbacks: ExecutionCallbacks = {
                  onNodeStart: (node: DAGNode) => {
                    socketRef.send(JSON.stringify({
                      type: "dag_node_status",
                      nodeId: node.title,
                      nodeName: node.title,
                      status: "RUNNING",
                      progress: 0,
                    }))
                  },
                  onNodeComplete: (node: DAGNode) => {
                    socketRef.send(JSON.stringify({
                      type: "dag_node_status",
                      nodeId: node.title,
                      nodeName: node.title,
                      status: "COMPLETED",
                      progress: 100,
                      output: node.toolOutput,
                    }))
                  },
                  onNodeFail: (node: DAGNode, error: string) => {
                    socketRef.send(JSON.stringify({
                      type: "dag_node_status",
                      nodeId: node.title,
                      nodeName: node.title,
                      status: "FAILED",
                      progress: 0,
                      error,
                    }))
                  },
                  onApprovalRequired: async (node: DAGNode, ctx: Record<string, unknown>) => {
                    // Create approval request
                    const approvalId = await createApprovalRequest(
                      orchestratorId,
                      node,
                      ctx,
                      (node.metadata?.assignedToUserId as string) || undefined,
                    )

                    socketRef.send(JSON.stringify({
                      type: "approval_request",
                      approvalId,
                      title: node.title,
                      context: ctx,
                      nodeId: node.title,
                    }))

                    // Wait for decision (polls StarGuard)
                    const decision = await waitForApprovalDecision(approvalId)

                    socketRef.send(JSON.stringify({
                      type: "approval_update",
                      approvalId,
                      status: decision === "approved" ? "APPROVED" : "REJECTED",
                    }))

                    return decision
                  },
                  onBroadcast: (channel: string, event: string, data: unknown) => {
                    socketRef.send(JSON.stringify({
                      type: "broadcast",
                      channel,
                      event,
                      data,
                    }))
                  },
                  onLog: (eventType: string, severity: string, title: string, metadata?: Record<string, unknown>) => {
                    socketRef.send(JSON.stringify({
                      type: "event_log",
                      eventType,
                      severity,
                      summary: title,
                      metadata,
                      timestamp: new Date().toISOString(),
                    }))

                    // Also persist to StarGuard
                    apiPost("/api/tokidapp/events", {
                      orchestratorId,
                      eventType,
                      severity,
                      title,
                      metadata,
                    }).catch(() => {})
                  },
                }

                // Execute the DAG
                const result = await executeDAG(orchestratorId, dag, callbacks)

                socketRef.send(JSON.stringify({
                  type: "orchestrator_state",
                  orchestratorId,
                  status: result.success ? "completed" : "failed",
                  result: {
                    success: result.success,
                    completedNodes: result.completedNodes,
                    failedNodes: result.failedNodes,
                    skippedNodes: result.skippedNodes,
                    totalNodes: result.totalNodes,
                    durationMs: result.durationMs,
                  },
                }))

                if (result.success) {
                  socketRef.send(JSON.stringify({
                    type: "voice_task_complete",
                    content: `Your workflow finished. ${result.completedNodes} steps completed. Would you like a quick overview, or should I fast-track the next planned tasks?`,
                    completedNodes: result.completedNodes,
                    durationMs: result.durationMs,
                  }))
                  socketRef.send(JSON.stringify({
                    type: "message",
                    content: `✅ Orchestration complete! ${result.completedNodes} tasks completed in ${(result.durationMs / 1000).toFixed(1)}s.`,
                  }))
                } else {
                  socketRef.send(JSON.stringify({
                    type: "error",
                    content: `Orchestration finished with errors: ${result.failedNodes} failed, ${result.skippedNodes} skipped. ${result.error || ""}`,
                  }))
                }
              } catch (e) {
                socketRef.send(JSON.stringify({
                  type: "error",
                  content: `Orchestration error: ${(e as Error).message}`,
                }))
              }
            })()
            return
          }

          if (msg.type === "approval_decision" && msg.approvalId) {
            // Resolve an approval decision in real-time
            ;(async () => {
              const decision = msg.decision as string
              if (decision === "approve" || decision === "reject") {
                resolveApproval(
                  msg.approvalId as string,
                  decision === "approve" ? "approved" : "rejected",
                )

                // Also persist to StarGuard
                await submitApprovalDecision(
                  msg.approvalId as string,
                  decision as "approve" | "reject",
                  msg.comment as string | undefined,
                )

                socketRef.send(JSON.stringify({
                  type: "approval_update",
                  approvalId: msg.approvalId,
                  status: decision === "approve" ? "APPROVED" : "REJECTED",
                }))
              }
            })()
            return
          }

          if (msg.type === "dag_query") {
            // Return current DAG state
            ;(async () => {
              const orchestratorId = orchestratorSessions.get(sessionId)
              if (orchestratorId) {
                try {
                  const res = await apiGet(`/api/tokidapp/orchestrator/${orchestratorId}`)
                  if (res.ok) {
                    const data = await res.json()
                    socketRef.send(JSON.stringify({ type: "orchestrator_state", ...data }))
                  }
                } catch { /* ignore */ }
              }
            })()
            return
          }

          if (msg.type === "message" && msg.content) {
            routeMessage(
              msg.content,
              (outgoing) => socketRef.send(outgoing),
              msg.workflowSlug,
              msg.workflowStep,
            )
            return
          }

          if (msg.type === "deploy" && msg.commitMsg) {
            ;(async () => {
              const gitResult = await gitCommitPush(msg.commitMsg, (outgoing) => socketRef.send(outgoing))
              socketRef.send(JSON.stringify({ type: "deploy_status", status: "committed", commitMsg: msg.commitMsg, commitHash: gitResult }))

              const deployResult = await triggerVercelDeploy((outgoing) => socketRef.send(outgoing))
              socketRef.send(JSON.stringify({ type: "deploy_status", status: deployResult.includes("failed") ? "failed" : "building", logs: deployResult }))
            })()
            return
          }
        } catch {
          // Ignore malformed JSON
        }
  })

  ws.on("close", cleanup)
  ws.on("error", cleanup)
}
